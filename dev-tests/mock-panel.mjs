/**
 * 复现面板渲染：用 mock chrome API 加载真实 panel.html，跑一遍完整 Agent 循环，
 * 截图 + 打印 #log 里每个子元素的 className / offsetHeight，定位"看不到回复"的根因。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PANEL = path.join(HERE, '..', 'browser-agent', 'panel.html');
const PORT = '9336';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = `
(function(){
  var llmCalls = 0;
  window.chrome = {
    runtime: {
      lastError: null,
      getURL: function(s){ return 'chrome-extension://fake/' + s; },
      sendMessage: function(msg, cb){
        msg = msg || {};
        var cmd = msg.cmd, args = msg.args || {};
        function done(data, delay){ setTimeout(function(){ if (cb) cb({ ok: true, data: data }); }, delay || 25); }
        switch (cmd) {
          case 'ping': return done('pong');
          case 'env.diag': return done({ engine:'138.0.0.0', manifestVersion:3, hasDebugger:true, hasScripting:true, hasCookies:true, hasStorage:true, hasAction:true, tabs:2 });
          case 'tab.list': return done([{ id:1, active:true, title:'测试页面', url:'https://example.com/' }]);
          case 'snapshot': return done('URL: https://example.com/\\nTITLE: 测试页\\nSCROLL: 0 / 900 (viewport 700)\\nELEMENTS(5):\\n[0] <a> 首页 href=https://example.com/\\n[1] <a> 关于\\n[2] <input type=text> label="用户名"\\n[3] <input type=password> label="密码"\\n[4] <button> 登录\\nTEXT:\\n- 欢迎回来');
          case 'net.list': return done('共 2 条:\\n#1 GET 200 application/json 2KB/120ms https://example.com/api/user [有响应体 520字符]\\n#2 POST 401 application/json 1KB/88ms https://example.com/api/login [有响应体 210字符]');
          case 'llm.fetch': {
            llmCalls++;
            var msgs = (args.body && args.body.messages) || [];
            var toolCount = 0;
            for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'tool') toolCount++;
            var m;
            if (toolCount < 8) {
              m = {
                role:'assistant',
                content: toolCount === 0 ? '我先看一下页面结构。' : '',
                reasoning_content: '第 ' + (toolCount + 1) + ' 步：继续分析页面元素与网络请求。',
                tool_calls: [{ id:'c' + toolCount, type:'function', function:{ name: (toolCount % 2 ? 'net_list' : 'browser_snapshot'), arguments: toolCount % 2 ? '{"limit":10}' : '{}' } }]
              };
            } else {
              m = { role:'assistant', content:'## 结论\\n\\n页面结构已拿到，登录接口是 **POST /api/login**，上次返回 401。\\n\\n- 用户名输入框：索引 [2]\\n- 密码输入框：索引 [3]\\n- 登录按钮：索引 [4]\\n\\n需要我填测试账号试一次吗？', reasoning_content:'信息齐了，给结论。', tool_calls: [] };
            }
            var payload = JSON.stringify({ id:'x', object:'chat.completion', choices:[{ index:0, message:m, finish_reason:'stop' }] });
            return done({ status: 200, ok: true, text: payload, ms: 120 }, 60);
          }
          default: return done('ok');
        }
      }
    },
    storage: { local: {
      get: function(k, cb){ setTimeout(function(){ cb && cb({}); }, 8); },
      set: function(o, cb){ if (cb) setTimeout(cb, 5); }
    } }
  };
})();
`;

async function connect() {
  for (let i = 0; i < 25; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const t = list.find((x) => x.type === 'page');
      if (t) return t;
    } catch (e) { /* retry */ }
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
await sleep(1600);

console.log('[1] 页面已加载');
console.log('    初始化日志条数:', await ev('document.querySelectorAll("#log > *").length'));
console.log('    状态栏:', await ev('document.querySelector("#status").textContent'));

console.log('[2] 触发 runAgent…');
await ev('runAgent("尝试绕过登录，这个是我自己的网站，你先试试水")').catch((e) => console.log('    runAgent 异常:', e.message));

for (let i = 0; i < 20; i++) {
  await sleep(400);
  const running = await ev('typeof running !== "undefined" ? running : false');
  if (!running) break;
}
await sleep(600);

console.log('[3] 运行结束，检查 DOM');
const dump = await ev(`(function(){
  var log = document.querySelector('#log');
  var out = [];
  var kids = log.children;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    var cs = getComputedStyle(k);
    out.push({
      i: i,
      cls: k.className || '(无class)',
      h: Math.round(k.getBoundingClientRect().height),
      display: cs.display,
      opacity: cs.opacity,
      text: (k.textContent || '').replace(/\\s+/g, ' ').slice(0, 46)
    });
  }
  return JSON.stringify({
    childCount: kids.length,
    logH: Math.round(log.getBoundingClientRect().height),
    scrollH: log.scrollHeight,
    scrollTop: Math.round(log.scrollTop),
    children: out
  }, null, 1);
})()`);
console.log(dump);

const shot = await call('Page.captureScreenshot', { format: 'png' });
const outPath = path.join(HERE, 'mock-shot.png');
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log('\n[4] 截图: ' + outPath);

ws.close();
process.exit(0);
