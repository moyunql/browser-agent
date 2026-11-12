/**
 * 验证新增功能：任务列表 / 删除任务 / 自定义系统提示词
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PANEL = path.join(HERE, '..', 'browser-agent', 'panel.html');
const PORT = '9337';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = `
(function(){
  window.__store = {};
  window.chrome = {
    runtime: {
      lastError: null,
      getURL: function(s){ return 'chrome-extension://fake/' + s; },
      sendMessage: function(msg, cb){
        msg = msg || {};
        var cmd = msg.cmd, args = msg.args || {};
        function done(data, delay){ setTimeout(function(){ if (cb) cb({ ok: true, data: data }); }, delay || 20); }
        switch (cmd) {
          case 'ping': return done('pong');
          case 'env.diag': return done({ engine:'138.0.0.0', manifestVersion:3, hasDebugger:true, hasScripting:true, hasCookies:true, hasStorage:true, hasAction:true, tabs:1 });
          case 'tab.list': return done([{ id:1, active:true, title:'测试页', url:'https://example.com/' }]);
          case 'snapshot': return done('URL: https://example.com/\\nTITLE: 测试页\\nELEMENTS(3):\\n[0] <input type=text> label="账号"\\n[1] <input type=password> label="密码"\\n[2] <button> 登录\\nTEXT:\\n- 请登录');
          case 'eval': return done('mock-eval-ok: ' + String(args.code || '').slice(0, 40));
          case 'llm.fetch': {
            var msgs = (args.body && args.body.messages) || [];
            var sys = msgs.length && msgs[0].role === 'system' ? msgs[0].content : '';
            window.__lastSystem = sys;
            if (sys.indexOf('上下文压缩器') !== -1) {
              return done({ status:200, ok:true, text: JSON.stringify({ choices:[{ message:{ role:'assistant', content:'【摘要】已定位登录表单：[0]账号 [1]密码 [2]按钮；登录接口 POST /api/login 返回 401。未解决：缺有效凭据。' } }] }), ms:50 }, 30);
            }
            var toolCount = 0;
            for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'tool') toolCount++;
            var m;
            if (toolCount < 2) {
              m = { role:'assistant', content: toolCount===0 ? '先看页面结构。' : '', reasoning_content:'分析中', tool_calls:[{ id:'c'+toolCount, type:'function', function:{ name:(toolCount===0?'browser_snapshot':'browser_click'), arguments: toolCount===0 ? '{}' : '{"index":2}' } }] };
            } else {
              m = { role:'assistant', content:'## 完成\\n\\n已定位登录表单：账号 [0]、密码 [1]、按钮 [2]。', tool_calls: [] };
            }
            return done({ status:200, ok:true, text: JSON.stringify({ choices:[{ index:0, message:m }] }), ms:80 }, 40);
          }
          default: return done('ok');
        }
      }
    },
    storage: { local: {
      get: function(keys, cb){
        var out = {};
        var ks = Array.isArray(keys) ? keys : [keys];
        for (var i=0;i<ks.length;i++){ if (ks[i] in window.__store) out[ks[i]] = window.__store[ks[i]]; }
        setTimeout(function(){ cb(out); }, 5);
      },
      set: function(obj, cb){ Object.keys(obj).forEach(function(k){ window.__store[k]=obj[k]; }); if (cb) setTimeout(cb, 5); }
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
  results.push({ name, ok, extra });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   ' + extra : ''));
};

console.log('=== 1. 任务列表初始状态 ===');
check('tasks 初始为空', (await ev('tasks.length')) === 0);
check('空态提示可见', /还没有任务记录/.test(await ev('document.querySelector("#taskList").textContent')));

console.log('\n=== 2. 跑一个任务，自动进入列表 ===');
await ev('runAgent("试试登录框")');
for (let i = 0; i < 25; i++) {
  await sleep(300);
  if (!(await ev('typeof running !== "undefined" && running'))) break;
}
await sleep(400);
const t0 = JSON.parse(await ev('JSON.stringify(tasks[0] || null)'));
console.log('    任务记录:', JSON.stringify(t0));
check('任务已入列表', !!t0);
check('状态为 done', t0 && t0.status === 'done', t0 && t0.status);
check('记录了步数', t0 && t0.steps > 0, t0 && t0.steps + ' 步');
check('标题取自用户输入', t0 && t0.title === '试试登录框');

console.log('\n=== 3. 任务面板渲染 ===');
await ev('toggleTaskPanel(true)');
await sleep(250);
const items = await ev('document.querySelectorAll("#taskList .task-item").length');
check('列表渲染出 1 条', items === 1, items + ' 条');
const metaTxt = await ev('document.querySelector("#taskList .task-meta").textContent');
check('显示时间/步数/状态', /步/.test(metaTxt) && /完成/.test(metaTxt), metaTxt);
const shot1 = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(HERE, 'shot-tasks.png'), Buffer.from(shot1.data, 'base64'));

console.log('\n=== 4. 删除任务 ===');
await ev('taskRemove(tasks[0].id)');
await sleep(200);
check('tasks 清空', (await ev('tasks.length')) === 0);
check('DOM 变为空态', /还没有任务记录/.test(await ev('document.querySelector("#taskList").textContent')));
check('storage 已同步', (await ev('(window.__store.tasks || []).length')) === 0);

console.log('\n=== 5. 自定义系统提示词 ===');
await ev('toggleTaskPanel(false)');
await ev('document.querySelector("#btnCfg").click()');
await sleep(200);
const emptyLen = await ev('document.querySelector("#cfgSysPrompt").value.length');
check('初始为空（走内置默认）', emptyLen === 0);

await ev('document.querySelector("#btnFillDefault").click()');
await sleep(150);
const filled = await ev('document.querySelector("#cfgSysPrompt").value');
check('填入内置默认', filled.length > 600, filled.length + ' 字');
check('默认含铁律段落', /铁律/.test(filled));
check('字数提示更新', /自定义中/.test(await ev('document.querySelector("#promptLen").textContent')));

// 改成一句自定义的，保存，验证真的注入到请求里
await ev('document.querySelector("#cfgSysPrompt").value = "你是一个只做一件事的助手：每次必须先 browser_snapshot。"');
await ev('saveCfg()');
await sleep(250);
check('设置已保存', (await ev('(window.__store.cfg || {}).systemPrompt || ""')).includes('只做一件事'));

await ev('runAgent("再试一次")');
for (let i = 0; i < 25; i++) {
  await sleep(300);
  if (!(await ev('typeof running !== "undefined" && running'))) break;
}
const usedSys = await ev('window.__lastSystem || ""');
check('自定义提示词已生效', /只做一件事/.test(usedSys), '实际发送: ' + String(usedSys).slice(0, 40));

await ev('document.querySelector("#btnClearPrompt").click()');
await sleep(120);
check('清空后字数提示', /空 · 当前用内置默认/.test(await ev('document.querySelector("#promptLen").textContent')));

console.log('\n=== 6. 额外提示词 + 技能多选 ===');
await ev('saveCfg()'); // 先存一次，让 systemPrompt 回到内置默认
await sleep(200);

const cbCount = await ev('document.querySelectorAll("#skillList input[data-skill]").length');
check('技能复选框已渲染', cbCount === 7, cbCount + ' 个');

// 单选：勾一个插入
await ev('document.querySelector(\'#skillList input[data-skill="pentest"]\').click()');
await sleep(120);
check('勾选后按钮计数', /插入选中 \(1\)/.test(await ev('document.querySelector("#btnInsertSkill").textContent')));
await ev('document.querySelector("#btnInsertSkill").click()');
await sleep(180);
const extra1 = await ev('document.querySelector("#cfgExtraPrompt").value');
check('插入渗透测试技能', /渗透测试作业模式/.test(extra1), extra1.length + ' 字');
check('插入后自动取消勾选', (await ev('document.querySelectorAll("#skillList input[data-skill]:checked").length')) === 0);

// 再勾一个
await ev('document.querySelector(\'#skillList input[data-skill="auth"]\').click()');
await ev('document.querySelector("#btnInsertSkill").click()');
await sleep(180);
const extra2 = await ev('document.querySelector("#cfgExtraPrompt").value');
check('第二个技能追加在后面', /环境声明/.test(extra2) && extra2.length > extra1.length, extra2.length + ' 字');

// 全选
await ev('document.querySelector("#skillAll").click()');
await sleep(150);
const allChecked = await ev('document.querySelectorAll("#skillList input[data-skill]:checked").length');
check('全选勾中全部', allChecked === 7, allChecked + '/7');
check('全选后按钮计数', /插入选中 \(7\)/.test(await ev('document.querySelector("#btnInsertSkill").textContent')));

await ev('document.querySelector("#btnInsertSkill").click()');
await sleep(250);
const extra3 = await ev('document.querySelector("#cfgExtraPrompt").value');
check('批量插入剩余技能', /接口抓取流程/.test(extra3) && extra3.length > extra2.length, extra3.length + ' 字');
check('已存在的被跳过', /跳过重复/.test(await ev('document.querySelector("#cfgHint").textContent')), await ev('document.querySelector("#cfgHint").textContent'));

// 再全选一次，全部重复应被拦
await ev('document.querySelector("#skillAll").click()');
await sleep(120);
await ev('document.querySelector("#btnInsertSkill").click()');
await sleep(200);
const extra4 = await ev('document.querySelector("#cfgExtraPrompt").value');
check('全量重复插入无变化', extra4.length === extra3.length);
check('重复时给出提示', /都已存在|跳过重复|已在/.test(await ev('document.querySelector("#cfgHint").textContent')));
check('字数提示更新', /已追加/.test(await ev('document.querySelector("#extraLen").textContent')));

await ev('saveCfg()');
await sleep(250);
const savedExtra = await ev('(window.__store.cfg || {}).extraPrompt || ""');
check('extraPrompt 已存盘', savedExtra.includes('渗透测试作业模式'));

await ev('runAgent("测试提示词拼接")');
for (let i = 0; i < 25; i++) {
  await sleep(300);
  if (!(await ev('typeof running !== "undefined" && running'))) break;
}
const sysUsed = await ev('window.__lastSystem || ""');
check('实际 system 含授权段', /运行环境与授权/.test(sysUsed));
check('实际 system 含技能段', /渗透测试作业模式/.test(sysUsed));
check('实际 system 含环境声明', /环境声明/.test(sysUsed));
check('内置默认也一并生效', /铁律/.test(sysUsed), sysUsed.length + ' 字');

console.log('\n=== 7. 无限步数 + 上下文自动压缩 ===');
check('默认步数为 0（不限制）', (await ev('DEFAULT_CFG.maxSteps')) === 0);
check('安全阀 300 存在', (await ev('HARD_STEP_CAP')) === 300);
check('压缩阈值 60000', (await ev('CONTEXT_SOFT_TOKENS')) === 60000);

const made = await ev(`(function(){
  messages.length = 0;
  messages.push({ role:'system', content:'你是 agent' });
  for (var i=0;i<30;i++){
    messages.push({ role:'user', content:'第 '+i+' 步：去看页面' });
    messages.push({ role:'assistant', content:'', tool_calls:[{ id:'c'+i, type:'function', function:{ name:'browser_snapshot', arguments:'{}' } }] });
    messages.push({ role:'tool', tool_call_id:'c'+i, content:'快照结果 '+i+'：' + new Array(500).join('x') });
  }
  return messages.length;
})()`);
const tokBefore = await ev('estimateTokens(messages)');
console.log('    构造消息数:', made, '| 估算 tokens:', tokBefore);

await ev('compressContext()');
await sleep(800);

const afterLen = await ev('messages.length');
const tokAfter = await ev('estimateTokens(messages)');
const firstRole = await ev('messages[0].role');
const hasSummary = await ev('String(messages[1].content).indexOf("压缩摘要") !== -1');
const orphan = await ev(`(function(){
  var bad = 0;
  for (var i = 1; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      var p = messages[i-1];
      var ok = p && p.role === 'assistant' && p.tool_calls && p.tool_calls.some(function(tc){ return tc.id === messages[i].tool_call_id; });
      if (!ok) bad++;
    }
  }
  return bad;
})()`);

check('消息数被压缩', afterLen < made, made + ' → ' + afterLen);
check('token 显著下降', tokAfter < tokBefore * 0.5, tokBefore + ' → ' + tokAfter);
check('system 仍在首位', firstRole === 'system');
check('摘要已插入', hasSummary);
check('无孤立 tool 消息（不会 400）', orphan === 0, orphan + ' 个');

console.log('\n=== 8. 直接执行 JS（绕过模型） ===');
await ev('document.querySelector("#btnJs").click()');
await sleep(150);
check('JS 面板已展开', !(await ev('document.querySelector("#jsBar").classList.contains("hidden")')));

await ev('document.querySelector("#jsInput").value = "document.title"');
await ev('document.querySelector("#btnRunJs").click()');
await sleep(500);
const jsOut = await ev('document.querySelector("#jsOut").textContent');
check('输出已显示', jsOut.indexOf('mock-eval-ok') !== -1, String(jsOut).slice(0, 45));
check('耗时提示出现', /完成|失败/.test(await ev('document.querySelector("#jsHint").textContent')));

await ev('document.querySelector("#btnClearJsOut").click()');
await sleep(120);
check('清空输出生效', (await ev('document.querySelector("#jsOut").textContent')) === '');

await ev('document.querySelector("#btnJs").click()');
await sleep(120);
check('再点可收起', await ev('document.querySelector("#jsBar").classList.contains("hidden")'));

await ev('document.querySelector("#cfgPanel").scrollTop = 99999');
await sleep(250);
const shot2 = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(HERE, 'shot-prompt.png'), Buffer.from(shot2.data, 'base64'));

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('\n===== 合计 ' + pass + ' 通过 / ' + fail + ' 失败 =====');
ws.close();
process.exit(fail === 0 ? 0 : 2);
