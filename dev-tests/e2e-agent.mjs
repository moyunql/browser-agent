/**
 * 端到端验证：模型 → 工具调用 → 真实 Chrome 操作 → 结果回灌 → 最终答复
 * 复用 background.js 里的 wbaSnapshot，工具用原生 CDP 实现（不依赖扩展运行时）。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BG = path.join(HERE, '..', 'browser-agent', 'background.js');
const PORT = process.env.CDP_PORT || '9333';
const BASE = process.env.LLM_BASE || 'http://127.0.0.1:8080/v1';
const KEY = process.env.LLM_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4.1-flash';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync(BG, 'utf8');
const fnSrc = src.slice(src.indexOf('function wbaSnapshot()'), src.indexOf('async function doSnapshot')).trim();

/* ---------- CDP ---------- */
const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
const target = list.find((x) => x.type === 'page' && !String(x.url).startsWith('devtools'));
if (!target) throw new Error('没有可用的页面 target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true });
});
function call(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('超时 ' + method)); } }, 15000);
  });
}
async function ev(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

await call('Runtime.enable');
await call('Page.enable');
await call('Page.navigate', { url: target.url });
await sleep(900);

/* ---------- 工具实现 ---------- */
const sel = (i) => '[data-wba="' + Number(i) + '"]';

async function toolSnapshot() {
  return await ev('(' + fnSrc + ')()');
}
async function rectOf(i) {
  return await ev(
    '(function(){var el=document.querySelector(' + JSON.stringify(sel(i)) + ');if(!el)return null;' +
    'el.scrollIntoView({block:"center",inline:"center"});var r=el.getBoundingClientRect();' +
    'return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,tag:el.tagName};})()'
  );
}
async function doClick(i) {
  let r = await rectOf(i);
  if (!r) { await toolSnapshot(); r = await rectOf(i); }
  if (!r) throw new Error('找不到序号 [' + i + ']，请重新 snapshot');
  const x = Math.round(r.x), y = Math.round(r.y);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(45);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  return '已点击 [' + i + '] <' + String(r.tag).toLowerCase() + '>';
}
async function doType(i, text, clear) {
  await doClick(i);
  if (clear) {
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(60);
  }
  await call('Input.insertText', { text: String(text) });
  await sleep(100);
  const v = await ev('(function(){var el=document.querySelector(' + JSON.stringify(sel(i)) + ');return el?("value" in el?el.value:(el.innerText||"")):null;})()');
  return '已输入到 [' + i + ']：' + text + '（当前值 ' + v + '）';
}

const TOOLS = [
  { type: 'function', function: { name: 'browser_snapshot', description: '获取页面快照：带编号 [0][1] 的可交互元素列表', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_type', description: '点击聚焦编号元素并输入文本', parameters: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' }, clear: { type: 'boolean' } }, required: ['index', 'text'] } } },
  { type: 'function', function: { name: 'browser_click', description: '按编号点击元素', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] } } },
];
async function exec(name, a) {
  if (name === 'browser_snapshot') return await toolSnapshot();
  if (name === 'browser_click') return await doClick(a.index);
  if (name === 'browser_type') return await doType(a.index, a.text, a.clear !== false);
  throw new Error('未知工具 ' + name);
}

/* ---------- Agent 循环 ---------- */
const SYS = '你是一个网页操作 Agent。用工具操作当前页面。规则：不知道页面结构就先 browser_snapshot；元素编号只在当前页面状态有效；一步一观察。完成后用中文简短说明你做了什么。';
const messages = [
  { role: 'system', content: SYS },
  { role: 'user', content: '在当前页面的搜索框里输入「蓝牙耳机Pro」，然后点击搜索按钮。' },
];

console.log('=== 端到端 Agent 测试 ===\n');
let step = 0, finalText = '';
while (step < 8) {
  step++;
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0 }),
  });
  const j = await res.json();
  if (j.error) throw new Error('模型错误: ' + JSON.stringify(j.error));
  const msg = j.choices[0].message;
  const calls = msg.tool_calls || [];
  console.log('--- 第 ' + step + ' 步 ---');
  if (msg.reasoning_content) console.log('思考: ' + String(msg.reasoning_content).slice(0, 160).replace(/\n/g, ' '));
  if (msg.content) console.log('内容: ' + String(msg.content).slice(0, 200));
  if (!calls.length) { finalText = msg.content || ''; break; }
  messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
  for (const tc of calls) {
    const name = tc.function.name;
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
    console.log('调用: ' + name + ' ' + JSON.stringify(args).slice(0, 120));
    let out;
    try { out = await exec(name, args); } catch (e) { out = 'ERROR: ' + e.message; }
    console.log('结果: ' + String(out).slice(0, 300).replace(/\n/g, ' | '));
    messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 12000) });
  }
  console.log('');
}
console.log('\n最终答复: ' + finalText);

/* ---------- 断言：页面真的变了 ---------- */
const state = await ev('JSON.stringify({search: document.querySelector(\'input[type=search]\').value, out: document.getElementById("out").textContent.trim()})');
const st = JSON.parse(state);
console.log('\n页面真实状态: ' + state);

let pass = 0, fail = 0;
const checks = [
  ['搜索框被写入正确内容', st.search === '蓝牙耳机Pro'],
  ['搜索按钮被真实点击（#out 变为"已搜索"）', st.out === '已搜索'],
  ['模型给出了最终答复', finalText.length > 4],
  ['步数在合理范围', step <= 8],
];
console.log('\n===== 结果 =====');
for (const [n, ok] of checks) { console.log((ok ? '  PASS  ' : '  FAIL  ') + n); ok ? pass++ : fail++; }
console.log('通过 ' + pass + ' / 失败 ' + fail);
ws.close();
process.exit(fail === 0 ? 0 : 2);
