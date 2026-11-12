/* ============================================================
 * background.js — CDP 桥 / 网络抓包缓存 / LLM 代理
 * 能力来源：chrome.debugger (Chrome DevTools Protocol)
 * ============================================================ */
'use strict';

const NET_MAX_RECORDS = 800;        // 每个 tab 保留的请求条数
const BODY_CACHE_LIMIT = 400000;    // 单条响应体缓存上限（字符）
const BODY_FETCH_MAX = 1500000;     // 超过该字节数不自动抓 body

/* ---------------- 状态 ---------------- */
const netStore = new Map();   // tabId -> { order: [], map: Map }
let seqCounter = 1;
let activeTabId = null;
const attachedTabs = new Set();

/* ---------------- 基础工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastErrMsg() {
  const e = chrome.runtime.lastError;
  return e ? e.message : null;
}

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const m = lastErrMsg();
      if (m) reject(new Error(m));
      else resolve(res);
    });
  });
}

function getTargets() {
  return new Promise((r) => chrome.debugger.getTargets((t) => r(t || [])));
}

/* ---------------- 附加调试器 ---------------- */
async function ensureAttached(tabId) {
  if (!tabId) throw new Error('没有可操作的目标标签页');
  const targets = await getTargets();
  const t = targets.find((x) => x.tabId === tabId);
  if (t && t.attached) {
    attachedTabs.add(tabId);
    return;
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const m = lastErrMsg();
      if (m) {
        if (/already attached|Another debugger is already attached/i.test(m)) return resolve();
        return reject(new Error('附加调试器失败：' + m + '（若该页已打开 DevTools，请先关闭 F12 面板再重试）'));
      }
      resolve();
    });
  });
  attachedTabs.add(tabId);
  await send(tabId, 'Page.enable').catch(() => {});
  await send(tabId, 'Runtime.enable').catch(() => {});
  await send(tabId, 'DOM.enable').catch(() => {});
  await send(tabId, 'Log.enable').catch(() => {});
  await send(tabId, 'Network.enable', {
    maxTotalBufferSize: 209715200,
    maxResourceBufferSize: 52428800,
    maxPostDataSize: 2097152,
  }).catch(() => {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === 'number') attachedTabs.delete(source.tabId);
});

/* ---------------- 网络事件 ---------------- */
function netFor(tabId) {
  let s = netStore.get(tabId);
  if (!s) {
    s = { order: [], map: new Map() };
    netStore.set(tabId, s);
  }
  return s;
}

function trimStore(s) {
  while (s.order.length > NET_MAX_RECORDS) {
    const old = s.order.shift();
    s.map.delete(old);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== 'number') return;
  if (!method.startsWith('Network.')) return;
  try {
    onNetEvent(tabId, method, params);
  } catch (e) {
    /* 事件处理不抛出，避免影响 CDP 通道 */
  }
});

function onNetEvent(tabId, method, params) {
  const s = netFor(tabId);
  if (method === 'Network.requestWillBeSent') {
    let rec = s.map.get(params.requestId);
    if (!rec) {
      rec = { seq: seqCounter++, id: params.requestId, ts: Date.now(), body: null, bodyTried: false };
      s.map.set(params.requestId, rec);
      s.order.push(params.requestId);
      trimStore(s);
    }
    if (params.redirectResponse) {
      rec.redirect = (rec.redirect || []).concat([
        { status: params.redirectResponse.status, url: params.redirectResponse.url },
      ]);
      rec.body = null;
      rec.bodyTried = false;
    }
    rec.url = params.request.url;
    rec.method = params.request.method;
    rec.type = params.type;
    rec.reqHeaders = params.request.headers;
    if (params.request.postData) rec.postData = params.request.postData;
    if (params.request.hasPostData === false) rec.postData = rec.postData || '';
  } else if (method === 'Network.responseReceived') {
    const rec = s.map.get(params.requestId);
    if (rec) {
      rec.status = params.response.status;
      rec.statusText = params.response.statusText;
      rec.mimeType = (params.response.mimeType || '').split(';')[0];
      rec.resHeaders = params.response.headers;
      rec.fromCache = !!params.response.fromDiskCache;
    }
  } else if (method === 'Network.loadingFinished') {
    const rec = s.map.get(params.requestId);
    if (rec) {
      rec.finished = true;
      rec.size = params.encodedDataLength;
      rec.duration = Date.now() - rec.ts;
      maybeCacheBody(tabId, rec);
    }
  } else if (method === 'Network.loadingFailed') {
    const rec = s.map.get(params.requestId);
    if (rec) {
      rec.finished = true;
      rec.error = params.errorText;
      rec.duration = Date.now() - rec.ts;
    }
  }
}

function maybeCacheBody(tabId, rec) {
  if (rec.bodyTried) return;
  rec.bodyTried = true;
  if (!rec.url || /^(data|blob|chrome-extension|about):/i.test(rec.url)) return;
  const t = rec.type;
  if (!['XHR', 'Fetch', 'Document', 'EventSource', 'Other'].includes(t)) return;
  if ((rec.size || 0) > BODY_FETCH_MAX) return;
  if (t !== 'Document' && !/json|text|javascript|xml|html|plain/i.test(rec.mimeType || '')) return;
  setTimeout(() => {
    send(tabId, 'Network.getResponseBody', { requestId: rec.id })
      .then((r) => {
        if (!r) return;
        let body = r.base64Encoded
          ? '[base64 ' + Math.round(r.body.length * 0.75) + ' bytes]'
          : String(r.body);
        if (body.length > BODY_CACHE_LIMIT) {
          body = body.slice(0, BODY_CACHE_LIMIT) + '\n...[响应体截断]';
          rec.truncated = true;
        }
        rec.body = body;
      })
      .catch(() => {
        rec.body = null;
      });
  }, 90);
}

/* ---------------- 网络查询 ---------------- */
function listRecords(tabId) {
  const s = netFor(tabId);
  return s.order.map((id) => s.map.get(id)).filter(Boolean);
}

function fmtNetList(tabId, opts) {
  opts = opts || {};
  let recs = listRecords(tabId);
  if (opts.filter) {
    const f = String(opts.filter).toLowerCase();
    recs = recs.filter((r) => {
      const hay = ((r.url || '') + ' ' + (r.method || '') + ' ' + (r.status || '') + ' ' + (r.mimeType || '') + ' ' + (r.type || '')).toLowerCase();
      return hay.includes(f);
    });
  }
  const limit = Math.min(Number(opts.limit) || 50, 300);
  recs = recs.slice(-limit);
  if (!recs.length) {
    return '(该标签页暂无网络记录，共 ' + listRecords(tabId).length + ' 条)。可用 net_clear 清空后刷新页面/执行操作再查看。';
  }
  const lines = recs.map((r) => {
    const st = r.status ? r.status : r.error ? 'ERR' : '…';
    const sz = r.size ? (r.size < 1024 ? r.size + 'B' : Math.round(r.size / 1024) + 'KB') : '?';
    const bits = [
      '#' + r.seq,
      (r.method || 'GET').padEnd(4),
      String(st).padEnd(4),
      (r.mimeType || r.type || '').slice(0, 24),
      sz + '/' + (r.duration || 0) + 'ms',
      r.url.length > 170 ? r.url.slice(0, 170) + '…' : r.url,
    ];
    if (r.body != null) bits.push('[有响应体 ' + r.body.length + '字符]');
    if (r.postData) bits.push('[有请求体]');
    if (r.error) bits.push('[' + r.error + ']');
    return bits.join(' ');
  });
  return '共 ' + recs.length + ' 条（最近 ' + limit + ' 条窗口内）:\n' + lines.join('\n');
}

async function netBody(tabId, seq) {
  const rec = listRecords(tabId).find((r) => r.seq === Number(seq));
  if (!rec) throw new Error('找不到编号 #' + seq + ' 的请求，请先调用 net_list 查看当前可用编号');
  let body = rec.body;
  if (body == null) {
    try {
      const r = await send(tabId, 'Network.getResponseBody', { requestId: rec.id });
      body = r.base64Encoded ? '[base64 数据 ' + Math.round(r.body.length * 0.75) + ' 字节]' : String(r.body);
    } catch (e) {
      body = null;
    }
  }
  const head = [
    '#' + rec.seq + ' ' + rec.method + ' ' + (rec.status || '') + ' ' + rec.url,
    '类型: ' + (rec.mimeType || rec.type || '?') + '  大小: ' + (rec.size || '?') + 'B  耗时: ' + (rec.duration || 0) + 'ms',
    '请求头: ' + JSON.stringify(rec.reqHeaders || {}).slice(0, 1000),
    rec.postData ? '请求体: ' + String(rec.postData).slice(0, 3000) : '',
    '响应头: ' + JSON.stringify(rec.resHeaders || {}).slice(0, 1000),
    '--- 响应体 ---',
  ].filter(Boolean).join('\n');
  return head + '\n' + (body != null ? body.slice(0, 16000) : '（响应体已不可用：浏览器已释放或该类型未缓存。重新触发该请求后再取）');
}

/* ---------------- 页面执行 ---------------- */
async function evaluate(tabId, expression, byValue) {
  const res = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: byValue !== false,
    awaitPromise: true,
    userGesture: true,
    includeCommandLineAPI: true,
    timeout: 20000,
  });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面内执行异常：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown'));
  }
  if (!res || !res.result) return undefined;
  if ('value' in res.result) return res.result.value;
  return res.result.description;
}

/* ---------------- DOM 快照 ---------------- */
function wbaSnapshot() {
  var MAXI = 240, MAXT = 2800;
  var vh = window.innerHeight;
  var info = {
    url: location.href,
    title: document.title || '',
    scrollY: Math.round(window.scrollY),
    docH: Math.round(document.documentElement.scrollHeight),
    vh: vh,
  };
  function clean(t, n) {
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }
  function vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return null;
    if (parseFloat(s.opacity || '1') === 0) return null;
    return { inView: r.top >= -40 && r.top < vh + 300 };
  }
  var SEL = 'a,button,input,textarea,select,summary,label,[role],[contenteditable=""],[contenteditable="true"],[tabindex],[onclick]';
  var all = document.querySelectorAll(SEL);
  var items = [];
  var idx = 0;
  for (var i = 0; i < all.length && idx < MAXI; i++) {
    var el = all[i];
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (el.closest && el.closest('script,style,noscript,head')) continue;
    var v;
    try { v = vis(el); } catch (e) { continue; }
    if (!v) continue;
    var tag = el.tagName.toLowerCase();
    // 过滤掉无文本、无 role、无 onclick 的纯容器（避免 [tabindex] 选择器带来的噪音）
    if (!el.getAttribute('role') && !el.getAttribute('onclick') &&
        (tag === 'div' || tag === 'span' || tag === 'li' || tag === 'section' || tag === 'ul') &&
        !clean(el.innerText, 40)) {
      continue;
    }
    try { el.setAttribute('data-wba', String(idx)); } catch (e) { continue; }
    var line = '[' + idx + '] <' + tag;
    if (el.type) line += ' type=' + el.type;
    var role = el.getAttribute('role');
    if (role) line += ' role=' + role;
    line += '>';
    var label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (label) line += ' label="' + clean(label, 50) + '"';
    var txt = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var itype = String(el.type || '').toLowerCase();
      if (itype === 'checkbox' || itype === 'radio') {
        /* 勾选类控件不输出 value="on" 这种噪音 */
      } else if (el.value) {
        txt = 'value="' + clean(el.value, 60) + '"';
      }
      if (tag === 'select' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
        txt += ' 选中="' + clean(el.options[el.selectedIndex].text, 30) + '"';
      }
    } else {
      txt = clean(el.innerText || el.textContent, 70);
    }
    if (txt) line += ' ' + txt;
    if (tag === 'a' && el.href) line += ' href=' + clean(el.href, 110);
    if (el.checked) line += ' [checked]';
    if (el.disabled) line += ' [disabled]';
    if (el.readOnly) line += ' [readonly]';
    if (!v.inView) line += ' (off-view)';
    items.push(line);
    idx++;
  }
  var texts = [];
  var seen = {};
  var blocks = document.querySelectorAll('h1,h2,h3,h4,h5,p,li,td,th,dd,dt,figcaption');
  for (var j = 0; j < blocks.length && j < 900 && texts.length < 26; j++) {
    var e2 = blocks[j];
    if (e2.querySelector && e2.querySelector('h1,h2,h3,p,li')) continue;
    var t2 = clean(e2.innerText, 120);
    if (t2.length < 5 || seen[t2]) continue;
    seen[t2] = 1;
    texts.push(t2);
    if (texts.join(' ').length > MAXT) break;
  }
  var out = [];
  out.push('URL: ' + info.url);
  out.push('TITLE: ' + clean(info.title, 120));
  out.push('SCROLL: ' + info.scrollY + ' / ' + info.docH + ' (viewport ' + info.vh + ')');
  out.push('ELEMENTS(' + items.length + (idx >= MAXI ? ',已达上限' : '') + '):');
  out.push(items.join('\n') || '(无可交互元素)');
  out.push('TEXT:');
  out.push(texts.length ? texts.map(function (t) { return '- ' + t; }).join('\n') : '(无文本)');
  return out.join('\n');
}

async function doSnapshot(tabId) {
  const expr = '(' + wbaSnapshot.toString() + ')()';
  return await evaluate(tabId, expr, true);
}

/* ---------------- 交互动作 ---------------- */
function selOf(idx) {
  return '[data-wba="' + Number(idx) + '"]';
}

async function rectOf(tabId, idx) {
  const expr =
    '(function(){var el=document.querySelector(' + JSON.stringify(selOf(idx)) + ');' +
    'if(!el)return null;el.scrollIntoView({block:"center",inline:"center"});' +
    'var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,tag:el.tagName};})()';
  return await evaluate(tabId, expr, true);
}

async function doClick(tabId, index, opts) {
  opts = opts || {};
  let rect = await rectOf(tabId, index);
  if (!rect) {
    await doSnapshot(tabId); // 兜底：可能是旧快照或页面已重渲染
    rect = await rectOf(tabId, index);
  }
  if (!rect) throw new Error('找不到序号 [' + index + '] 的元素。请先调用 browser_snapshot 获取最新元素编号（页面重渲染后编号会失效）。');
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(45);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(Number(opts.wait) || 260);
  return '已点击 [' + index + '] <' + String(rect.tag || '').toLowerCase() + '> @(' + x + ',' + y + ')';
}

async function doType(tabId, index, text, opts) {
  opts = opts || {};
  const t = String(text == null ? '' : text);
  await doClick(tabId, index, { wait: 130 });
  if (opts.clear) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(60);
  }
  await send(tabId, 'Input.insertText', { text: t });
  await sleep(90);
  const probe = await evaluate(
    tabId,
    '(function(){var el=document.querySelector(' + JSON.stringify(selOf(index)) + ');return el?("value" in el?el.value:(el.innerText||"")):null;})()',
    true
  );
  const head = t.slice(0, 4);
  if (probe != null && head && !String(probe).includes(head)) {
    // React/Vue 受控组件兜底：走原生 value setter + 事件派发
    const fallback =
      '(function(){var el=document.querySelector(' + JSON.stringify(selOf(index)) + ');if(!el)return "no-el";' +
      'var tag=el.tagName.toLowerCase();' +
      'var proto=tag==="textarea"?HTMLTextAreaElement.prototype:(tag==="select"?HTMLSelectElement.prototype:HTMLInputElement.prototype);' +
      'var d=Object.getOwnPropertyDescriptor(proto,"value");' +
      'if(d&&d.set){d.set.call(el,' + JSON.stringify(t) + ');}else{el.value=' + JSON.stringify(t) + ';}' +
      'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));' +
      'return el.value===undefined?"ok":el.value;})()';
    const r2 = await evaluate(tabId, fallback, true);
    return '已输入到 [' + index + ']（原生 setter 兜底）：' + t.slice(0, 60) + ' → value=' + String(r2).slice(0, 40);
  }
  return '已输入到 [' + index + ']：' + t.slice(0, 60) + (probe != null ? '（当前值: ' + String(probe).slice(0, 40) + '）' : '');
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};

async function doPress(tabId, key) {
  const k = KEYMAP[key] || KEYMAP[String(key).trim()];
  if (!k) throw new Error('不支持的按键：' + key + '（支持 Enter/Tab/Escape/Backspace/Delete/Space/Arrow* /PageUp/PageDown/Home/End）');
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  if (k.text) await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'char', text: k.text, unmodifiedText: k.text }, base));
  await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await sleep(180);
  return '已按下 ' + (k.key === ' ' ? 'Space' : k.key);
}

async function doScroll(tabId, p) {
  p = p || {};
  let expr;
  if (p.index != null && p.index !== '') {
    expr = '(function(){var el=document.querySelector(' + JSON.stringify(selOf(p.index)) + ');if(!el)return "no-el";el.scrollIntoView({block:"center",behavior:"instant"});return "ok";})()';
  } else if (p.to === 'bottom') {
    expr = 'window.scrollTo(0, document.documentElement.scrollHeight); "ok"';
  } else if (p.to === 'top') {
    expr = 'window.scrollTo(0, 0); "ok"';
  } else {
    expr = 'window.scrollBy(0, ' + (Number(p.dy) || 700) + '); "ok"';
  }
  const r = await evaluate(tabId, expr, true);
  if (r === 'no-el') throw new Error('找不到序号 [' + p.index + '] 的元素');
  await sleep(260);
  return '已滚动 → ' + (await evaluate(tabId, 'Math.round(window.scrollY) + " / " + document.documentElement.scrollHeight', true));
}

/* ---------------- 标签页 ---------------- */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const rows = tabs
    .filter((t) => !String(t.url || '').startsWith('chrome-extension://'))
    .map((t) => ({ id: t.id, active: t.id === activeTabId, title: (t.title || '').slice(0, 60), url: (t.url || '').slice(0, 120), windowId: t.windowId }));
  return rows;
}

async function resolveTabId() {
  if (activeTabId) {
    try {
      const t = await chrome.tabs.get(activeTabId);
      if (t && !String(t.url || '').startsWith('chrome-extension://')) return activeTabId;
    } catch (e) { /* tab 已关闭 */ }
  }
  const wins = await chrome.windows.getAll({ populate: true });
  const normal = wins.filter((w) => w.type === 'normal');
  const focused = normal.filter((w) => w.focused)[0] || normal[0];
  if (focused) {
    const at = (focused.tabs || []).filter((t) => t.active && !String(t.url || '').startsWith('chrome-extension://'))[0];
    if (at) {
      activeTabId = at.id;
      return at.id;
    }
  }
  const tabs = await chrome.tabs.query({});
  const cand = tabs.filter((t) => !String(t.url || '').startsWith('chrome-extension://'))[0];
  if (!cand) throw new Error('没有找到可操作的网页标签页，请先打开一个网页');
  activeTabId = cand.id;
  return cand.id;
}

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const w = await chrome.windows.get(info.windowId);
    if (w.type !== 'normal') return;
    const t = await chrome.tabs.get(info.tabId);
    if (String(t.url || '').startsWith('chrome-extension://')) return;
    activeTabId = info.tabId;
  } catch (e) { /* ignore */ }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  netStore.delete(tabId);
  attachedTabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
});

/* ---------------- 命令分发 ---------------- */
const CMD = {
  async ping() { return 'pong'; },

  /* 环境自检：国产壳（2345/QQ/360 等）是否阉割了关键 API，一看便知 */
  async 'env.diag'(p) {
    const ua = navigator.userAgent || '';
    const m = ua.match(/(?:Chrome|Chromium)\/([\d.]+)/);
    const info = {
      engine: m ? m[1] : '未知',
      ua,
      manifestVersion: chrome.runtime.getManifest().manifest_version,
      hasDebugger: !!(chrome.debugger && chrome.debugger.attach && chrome.debugger.sendCommand),
      hasScripting: !!(chrome.scripting && chrome.scripting.executeScript),
      hasCookies: !!(chrome.cookies && chrome.cookies.getAll),
      hasStorage: !!(chrome.storage && chrome.storage.local),
      hasAction: !!(chrome.action || chrome.browserAction),
    };
    try {
      const tabs = await chrome.tabs.query({});
      info.tabs = tabs.length;
    } catch (e) {
      info.tabs = 0;
    }
    if (!(p && p.attach)) return info;

    let tabId = null;
    try {
      tabId = await resolveTabId();
      info.tabId = tabId;
    } catch (e) {
      info.tabErr = e.message;
    }
    if (tabId) {
      try {
        await ensureAttached(tabId);
        info.attach = 'ok';
        try {
          info.href = await evaluate(tabId, 'location.href', true);
          info.eval = 'ok';
        } catch (e) {
          info.eval = '失败：' + e.message;
        }
        try {
          const r = await send(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          info.screenshot = r && r.data ? 'ok' : '失败：无数据';
        } catch (e) {
          info.screenshot = '失败：' + e.message;
        }
        try {
          await send(tabId, 'Network.enable', {});
          info.network = 'ok';
        } catch (e) {
          info.network = '失败：' + e.message;
        }
      } catch (e) {
        info.attach = '失败：' + e.message;
      }
    }
    return info;
  },

  async 'tab.list'() { return await listTabs(); },

  async 'tab.use'(p) {
    const id = Number(p.tabId);
    const t = await chrome.tabs.get(id);
    await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    activeTabId = id;
    return '已切换到标签页 ' + id + '：' + (t.title || t.url);
  },

  async nav(p) {
    const tabId = await resolveTabId();
    let url = String(p.url || '').trim();
    if (!url) throw new Error('缺少 url');
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    await chrome.tabs.update(tabId, { url });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await sleep(400);
      try {
        const st = await evaluate(tabId, 'document.readyState', true);
        if (st === 'complete') break;
      } catch (e) { /* 导航中上下文销毁，正常 */ }
    }
    await sleep(350);
    const info = await evaluate(tabId, 'location.href + " || " + document.title', true).catch(() => '');
    return '已导航到 ' + url + (info ? '\n当前：' + info : '');
  },

  async snapshot(p) {
    const tabId = await resolveTabId();
    return await doSnapshot(tabId);
  },

  async click(p) {
    const tabId = await resolveTabId();
    return await doClick(tabId, p.index, p);
  },

  async type(p) {
    const tabId = await resolveTabId();
    return await doType(tabId, p.index, p.text, p);
  },

  async press(p) {
    const tabId = await resolveTabId();
    return await doPress(tabId, p.key);
  },

  async scroll(p) {
    const tabId = await resolveTabId();
    return await doScroll(tabId, p);
  },

  async eval(p) {
    const tabId = await resolveTabId();
    const code = String(p.code || p.expression || '');
    if (!code) throw new Error('缺少 code');
    const out = await evaluate(tabId, code, true);
    if (out === undefined) return '(返回值 undefined)';
    if (typeof out === 'string') return out;
    try { return JSON.stringify(out, null, 1).slice(0, 12000); } catch (e) { return String(out); }
  },

  async 'net.list'(p) {
    const tabId = await resolveTabId();
    return fmtNetList(tabId, p);
  },

  async 'net.body'(p) {
    const tabId = await resolveTabId();
    return await netBody(tabId, p.seq);
  },

  async 'net.clear'() {
    const tabId = await resolveTabId();
    netStore.delete(tabId);
    return '该标签页网络记录已清空';
  },

  async shot() {
    const tabId = await resolveTabId();
    const r = await send(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return 'data:image/png;base64,' + r.data;
  },

  async cookies(p) {
    const tabId = await resolveTabId();
    const tab = await chrome.tabs.get(tabId);
    const list = await chrome.cookies.getAll({ url: tab.url });
    return list.slice(0, 60).map((c) => c.name + '=' + String(c.value).slice(0, 80) + (c.httpOnly ? ' [HttpOnly]' : '') + (c.secure ? ' [Secure]' : '')).join('\n') || '(无 Cookie)';
  },

  async wait(p) {
    const ms = Math.min(Number(p.ms) || 800, 30000);
    if (p.selector) {
      const tabId = await resolveTabId();
      const expr = '(function(){return !!document.querySelector(' + JSON.stringify(String(p.selector)) + ');})()';
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          if (await evaluate(tabId, expr, true)) return '元素已出现：' + p.selector + '（' + (Date.now() - t0) + 'ms）';
        } catch (e) { /* ignore */ }
        await sleep(250);
      }
      return '等待超时：' + p.selector + ' 在 ' + ms + 'ms 内未出现';
    }
    await sleep(ms);
    return '已等待 ' + ms + 'ms';
  },

  /* LLM 代理：绕开扩展页面的 CORS / 混合内容限制 */
  async 'llm.fetch'(p) {
    const t0 = Date.now();
    const res = await fetch(p.url, {
      method: p.method || 'POST',
      headers: p.headers || {},
      body: p.body ? JSON.stringify(p.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, ms: Date.now() - t0 };
  },

  async 'debug.detach'() {
    const tabId = await resolveTabId();
    await new Promise((r) => chrome.debugger.detach({ tabId }, () => r()));
    attachedTabs.delete(tabId);
    return '已分离调试器';
  },
};

/* ---------------- 消息入口 ---------------- */
// 这些命令不需要预先附加调试器（或不能预先附加）
const NO_ATTACH_CMDS = ['ping', 'llm.fetch', 'tab.list', 'tab.use', 'debug.detach', 'env.diag'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return false;
  const fn = CMD[msg.cmd];
  if (!fn) {
    sendResponse({ ok: false, error: '未知命令: ' + msg.cmd });
    return false;
  }
  Promise.resolve()
    .then(async () => {
      if (NO_ATTACH_CMDS.indexOf(msg.cmd) === -1) {
        const tabId = await resolveTabId();
        await ensureAttached(tabId);
      }
      return await fn(msg.args || {});
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true; // 异步响应
});

/* ---------------- 打开主面板 ---------------- */
const PANEL_W = 560;
const PANEL_H = 880;

async function openPanel() {
  const url = chrome.runtime.getURL('panel.html');
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.type !== 'popup') continue;
    const hit = (w.tabs || []).find((t) => String(t.url || '').startsWith(url));
    if (hit) {
      await chrome.windows.update(w.id, { focused: true });
      return;
    }
  }
  // service worker 里没有 screen 对象，稳妥取屏宽
  let sw = 1920;
  try {
    if (typeof screen !== 'undefined' && screen && screen.width) sw = screen.width;
  } catch (e) { /* ignore */ }
  await chrome.windows.create({
    url,
    type: 'popup',
    width: PANEL_W,
    height: PANEL_H,
    top: 60,
    left: Math.max(0, sw - PANEL_W - 40),
  });
}

chrome.action.onClicked.addListener(() => { openPanel(); });

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['cfg'], (r) => {
    if (!r || !r.cfg) {
      chrome.storage.local.set({
        cfg: {
          base: 'http://127.0.0.1:8080/v1', // 首次使用请在面板 ⚙ 里改
          key: '', // 首次使用请在面板 ⚙ 里填写，不要写进代码
          model: 'deepseek-v4.1-flash',
          maxSteps: 30,
        },
      });
    }
  });
  // 首次安装直接把面板弹出来，省得用户找不到入口
  if (details && details.reason === 'install') {
    setTimeout(() => {
      openPanel().catch(() => { /* 壳子若不允许建窗口，忽略即可 */ });
    }, 700);
  }
});
