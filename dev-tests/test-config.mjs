/**
 * 验证配置修复：输入即生效 / 状态条 / 自动保存 / 发送前校验 / 检查更新
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PANEL = path.join(HERE, '..', 'browser-agent', 'panel.html');
const PORT = '9338';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = `
(function(){
  window.__store = {};
  window.__opened = [];
  window.chrome = {
    runtime: {
      lastError: null,
      getURL: function(s){ return 'chrome-extension://fake/' + s; },
      getManifest: function(){ return { version: '1.6.0', manifest_version: 3 }; },
      sendMessage: function(msg, cb){
        msg = msg || {};
        var cmd = msg.cmd, args = msg.args || {};
        function done(data, delay){ setTimeout(function(){ if (cb) cb({ ok:true, data:data }); }, delay || 20); }
        switch (cmd) {
          case 'ping': return done('pong');
          case 'env.diag': return done({ engine:'138.0.0.0', manifestVersion:3, hasDebugger:true, hasScripting:true, hasCookies:true, hasStorage:true, hasAction:true, tabs:1 });
          case 'tab.list': return done([{ id:1, active:true, title:'测试页', url:'https://example.com/' }]);
          case 'snapshot': return done('URL: https://example.com/\\nTITLE: 测试页\\nELEMENTS(1):\\n[0] <button> 登录');
          case 'llm.fetch': {
            // 用于 checkUpdate：返回一个更高版本的 version.json
            if (String(args.url || '').indexOf('version.json') >= 0) {
              return done({ status:200, ok:true, text: JSON.stringify({ version:'9.9.9', notes:['测试更新说明'], download:'https://example.com/dl.zip' }), ms:30 }, 30);
            }
            var msgs = (args.body && args.body.messages) || [];
            window.__lastSystem = msgs.length && msgs[0].role === 'system' ? msgs[0].content : '';
            var toolCount = 0;
            for (var i=0;i<msgs.length;i++) if (msgs[i].role === 'tool') toolCount++;
            var m = toolCount === 0
              ? { role:'assistant', content:'先看页面', tool_calls:[{ id:'c1', type:'function', function:{ name:'browser_snapshot', arguments:'{}' } }] }
              : { role:'assistant', content:'完成', tool_calls:[] };
            return done({ status:200, ok:true, text: JSON.stringify({ choices:[{ message:m }] }), ms:50 }, 40);
          }
          default: return done('ok');
        }
      }
    },
    storage: { local: {
      get: function(keys, cb){
        var out = {}, ks = Array.isArray(keys) ? keys : [keys];
        for (var i=0;i<ks.length;i++) if (ks[i] in window.__store) out[ks[i]] = window.__store[ks[i]];
        setTimeout(function(){ cb(out); }, 5);
      },
      set: function(obj, cb){ Object.keys(obj).forEach(function(k){ window.__store[k]=obj[k]; }); if (cb) setTimeout(cb, 5); }
    } },
    tabs: { create: function(o){ window.__opened.push(o.url); } }
  };
})();
`;

async function connect() {
  for (let i = 0; i < 25; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = list.find((x) => x.type === 'page');
      if (t) return t;
    } catch (e) {}
    await sleep(400);
  }
  throw new Error('CDP 连不上');
}

const target = await connect();
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
  ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true });
});
function call(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 20000);
  });
}
async function ev(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

await call('Runtime.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 560, height: 880, deviceScaleFactor: 1, mobile: false });
await call('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
await call('Page.navigate', { url: 'file:///' + PANEL.replace(/\\/g, '/').replace(/^\/+/, '') });
await sleep(1500);

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
};

console.log('=== 1. 初始状态 ===');
await ev('document.querySelector("#btnCfg").click()');
await sleep(250);
check('面板已展开', !(await ev('document.querySelector("#cfgPanel").classList.contains("hidden")')));
const st0 = await ev('document.querySelector("#cfgStatus").className + "|" + document.querySelector("#cfgStatus").textContent');
check('缺 Key 时标红', /err/.test(st0), st0.slice(0, 40));

console.log('\n=== 2. 输入即生效（不点保存） ===');
await ev(`
  var b = document.querySelector('#cfgBase');
  b.value = 'https://api.test.com/v1';
  b.dispatchEvent(new Event('input', { bubbles: true }));
  var k = document.querySelector('#cfgKey');
  k.value = 'sk-test-123456';
  k.dispatchEvent(new Event('input', { bubbles: true }));
  'ok'
`);
await sleep(150);
check('内存 cfg.base 立即更新', (await ev('cfg.base')) === 'https://api.test.com/v1', await ev('cfg.base'));
check('内存 cfg.key 立即更新', (await ev('cfg.key')) === 'sk-test-123456');
check('状态条转绿', /ok/.test(await ev('document.querySelector("#cfgStatus").className')));
check('显示已就绪', /已就绪/.test(await ev('document.querySelector("#cfgStatus").textContent')));
check('显示 Key ✓', /Key ✓/.test(await ev('document.querySelector("#cfgStatus").textContent')));

console.log('\n=== 3. 防抖自动写盘 ===');
await sleep(1000);
const savedKey = await ev('(window.__store.cfg || {}).key');
const savedBase = await ev('(window.__store.cfg || {}).base');
check('已自动写入 storage', savedKey === 'sk-test-123456' && savedBase === 'https://api.test.com/v1', savedKey);

console.log('\n=== 4. 清空 Key 后应立即标红 ===');
await ev('var k=document.querySelector("#cfgKey"); k.value=""; k.dispatchEvent(new Event("input",{bubbles:true})); "ok"');
await sleep(120);
check('状态条转红', /err/.test(await ev('document.querySelector("#cfgStatus").className')));
check('提示缺 API Key', /缺 API Key/.test(await ev('document.querySelector("#cfgStatus").textContent')));

console.log('\n=== 5. 发送前拦截 ===');
await ev('document.querySelector("#cfgPanel").classList.add("hidden")');
await sleep(100);
await ev('runAgent("测试一下")');
await sleep(500);
const logText = await ev('document.querySelector("#log").textContent');
check('日志提示缺 API Key', /还没配置 API Key/.test(logText));
check('自动打开设置面板', !(await ev('document.querySelector("#cfgPanel").classList.contains("hidden")')));
check('没有启动执行', (await ev('running')) === false);

console.log('\n=== 6. 填回 Key 后可正常运行 ===');
await ev('var k=document.querySelector("#cfgKey"); k.value="sk-ok"; k.dispatchEvent(new Event("input",{bubbles:true})); "ok"');
await sleep(150);
await ev('document.querySelector("#log").innerHTML = ""');  // 清掉上一步的报错，避免误判
await ev('runAgent("再来一次")');
for (let i = 0; i < 20; i++) { await sleep(300); if (!(await ev('running'))) break; }
const logText2 = await ev('document.querySelector("#log").textContent');
check('正常跑完（无缺 Key 提示）', !/还没配置/.test(logText2), logText2.slice(0, 40).replace(/\s+/g, ' '));
check('任务已入库', (await ev('tasks.length')) > 0, (await ev('tasks.length')) + ' 条');

console.log('\n=== 7. 检查更新 ===');
await ev('document.querySelector("#cfgPanel").classList.remove("hidden")');
await ev('document.querySelector("#btnCheckUpdate").click()');
await sleep(900);
const upd = await ev('document.querySelector("#updateHint").textContent');
check('识别到新版本', /发现 v9\.9\.9/.test(upd), upd);
await ev('document.querySelector("#updateHint").click()');
await sleep(300);
const opened = await ev('JSON.stringify(window.__opened)');
check('点击可打开下载地址', /dl\.zip/.test(opened), opened);

await ev('document.querySelector("#cfgPanel").scrollTop = 0');
await sleep(200);
const shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(HERE, 'shot-config.png'), Buffer.from(shot.data, 'base64'));

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====');
ws.close();
process.exit(fail === 0 ? 0 : 2);
