/**
 * 用真实 Chrome（headless + CDP）验证 background.js 里的 wbaSnapshot 注入函数。
 * 只依赖 Node 22 内置的全局 fetch / WebSocket。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BG = path.join(HERE, '..', 'browser-agent', 'background.js');
const PORT = process.env.CDP_PORT || '9333';

const src = fs.readFileSync(BG, 'utf8');
const a = src.indexOf('function wbaSnapshot()');
const b = src.indexOf('async function doSnapshot');
if (a < 0 || b < 0) {
  console.error('FAIL: 没找到 wbaSnapshot 函数');
  process.exit(1);
}
const fnSrc = src.slice(a, b).trim();
console.log('[1] 提取 wbaSnapshot 源码 ' + fnSrc.length + ' 字符');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = list.find((x) => x.type === 'page' && !String(x.url).startsWith('devtools'));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch (e) { /* chrome 还没起来 */ }
    await sleep(400);
  }
  throw new Error('连不上 Chrome CDP :' + PORT);
}

const target = await getPageTarget();
console.log('[2] 已连接页面: ' + target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});

function call(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时: ' + method)); }
    }, 15000);
  });
}

async function evaluate(expression) {
  const r = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    includeCommandLineAPI: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result ? r.result.value : undefined;
}

await call('Runtime.enable');
await call('Page.enable');

// 每次运行先重载页面，避免上一次测试改动的 value 污染断言
try {
  await call('Page.navigate', { url: target.url });
  await sleep(900);
} catch (e) { /* file:// 页面重载失败也无妨 */ }

/* ---- 测试 1：快照 ---- */
console.log('[3] 执行快照…');
const snap = await evaluate('(' + fnSrc + ')()');
console.log('---------- SNAPSHOT 输出 ----------');
console.log(snap);
console.log('------------------------------------');

const checks = [
  ['含 URL', /URL: file:\/\//.test(snap)],
  ['含标题', /TITLE: 快照测试页/.test(snap)],
  ['带编号元素', /\[\d+\] <(input|button|a|select|label)/.test(snap)],
  ['搜索框默认值', /value="无线耳机"/.test(snap)],
  ['placeholder 识别', /label="搜索商品"/.test(snap)],
  ['禁用元素被过滤', !snap.includes('这个不应该出现')],
  ['链接 href', /href=https:\/\/example\.com\/a\/1/.test(snap)],
  ['checked 状态', /\[checked\]/.test(snap)],
  ['select 选中项', /选中="销量优先"/.test(snap)],
  ['文本块', /TEXT:/.test(snap) && /降噪蓝牙耳机/.test(snap)],
  ['输出长度合理', snap.length > 400 && snap.length < 12000],
];

/* ---- 测试 2：按编号定位（rectOf 表达式）---- */
console.log('[4] 验证编号定位…');
const rect = await evaluate(
  '(function(){var el=document.querySelector(\'[data-wba="1"]\');if(!el)return null;' +
  'el.scrollIntoView({block:"center",inline:"center"});var r=el.getBoundingClientRect();' +
  'return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,tag:el.tagName};})()'
);
const rectOk = rect && rect.w > 2 && rect.h > 2 && /input|button|a|select|label/i.test(rect.tag);
console.log('    元素[1] = ' + (rect ? '<' + rect.tag + '> @' + Math.round(rect.x) + ',' + Math.round(rect.y) + ' ' + Math.round(rect.w) + 'x' + Math.round(rect.h) : 'null'));

/* ---- 测试 3：类型协议 fallback 表达式 ---- */
console.log('[5] 验证 React 兜底 setter…');
const setterOk = await evaluate(
  '(function(){var el=document.querySelector(\'[data-wba="0"]\');if(!el)return "no-el";' +
  'var tag=el.tagName.toLowerCase();' +
  'var proto=tag==="textarea"?HTMLTextAreaElement.prototype:(tag==="select"?HTMLSelectElement.prototype:HTMLInputElement.prototype);' +
  'var d=Object.getOwnPropertyDescriptor(proto,"value");' +
  'if(d&&d.set){d.set.call(el,"鼠标键盘耳机");}else{el.value="鼠标键盘耳机";}' +
  'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));' +
  'return el.value;})()'
);
console.log('    设置后 value = ' + setterOk);

/* ---- 汇总 ---- */
let pass = 0, fail = 0;
console.log('\n===== 测试结果 =====');
for (const [name, ok] of checks) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  ok ? pass++ : fail++;
}
console.log((rectOk ? '  PASS  ' : '  FAIL  ') + '按编号定位元素');
rectOk ? pass++ : fail++;
console.log((setterOk === '鼠标键盘耳机' ? '  PASS  ' : '  FAIL  ') + 'React 兜底 setter (' + setterOk + ')');
(setterOk === '鼠标键盘耳机') ? pass++ : fail++;
console.log('--------------------');
console.log('通过 ' + pass + ' / 失败 ' + fail);

ws.close();
process.exit(fail === 0 ? 0 : 2);
