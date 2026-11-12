/**
 * 本地登录靶场 —— 能力和 lubansms 那套对等，但目标是你自己的 127.0.0.1
 *
 * 零依赖，纯 Node 内置模块跑：
 *   node lab/server.js
 *   浏览器打开 http://127.0.0.1:8899
 *
 * 内置的可测弱点（都是真实系统里常见的，练熟了能直接看穿）：
 *   1. 图形验证码：4 位数字、字体固定、无扭曲 —— 可逐像素还原
 *   2. 验证码校验逻辑缺陷：vercode 传空字符串直接跳过校验
 *   3. 无失败次数限制，可无限猜
 *   4. 用户名枚举：错误信息区分"用户不存在"和"密码错误"
 *   5. /api/users 未鉴权，直接泄露全部账号
 *   6. 弱口令 admin / 123456
 */
'use strict';

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = 8899;

/* ============================================================
 * 5x7 点阵数字（固定字体 = 可被像素级还原，这是靶场的教学点）
 * ============================================================ */
const DIGITS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/* ============================================================
 * PNG 编码（无第三方库）
 * ============================================================ */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, pixels) {
  // pixels: Buffer(RGBA)，每行前加 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画一张 70x25 的 4 位数字验证码 */
function makeCaptcha(text) {
  const W = 70, H = 25, SCALE = 3;
  const px = Buffer.alloc(W * H * 4);
  // 白底
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = 255;
    px[i * 4 + 1] = 255;
    px[i * 4 + 2] = 255;
    px[i * 4 + 3] = 255;
  }
  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  // 噪点
  for (let n = 0; n < 45; n++) {
    setPx(Math.floor(Math.random() * W), Math.floor(Math.random() * H), 170, 170, 170);
  }
  // 画数字：字体固定、位置固定、无旋转 —— 所以点阵可还原
  for (let i = 0; i < 4; i++) {
    const glyph = DIGITS[text[i]] || DIGITS['0'];
    const ox = 2 + i * 17;
    const oy = 2;
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (glyph[ry][rx] !== '1') continue;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            setPx(ox + rx * SCALE + sx, oy + ry * SCALE + sy, 22, 40, 90);
          }
        }
      }
    }
  }
  return encodePNG(W, H, px);
}

/* ============================================================
 * 数据与状态
 * ============================================================ */
const USERS = [
  { id: 1, username: 'admin', password: '123456', role: 'admin', email: 'admin@lab.local', balance: 9999 },
  { id: 2, username: 'operator', password: 'op1234', role: 'operator', email: 'op@lab.local', balance: 120 },
  { id: 3, username: 'demo', password: 'demo', role: 'user', email: 'demo@lab.local', balance: 0 },
];

const sessions = new Map(); // sid -> { username?, captcha }
const FLAG = 'FLAG{lab_login_bypass_7f3a91c2}';

function newSid() {
  return crypto.randomBytes(12).toString('hex');
}

function getSid(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}

function ensureSession(req, res) {
  let sid = getSid(req);
  if (!sid || !sessions.has(sid)) {
    sid = newSid();
    sessions.set(sid, { captcha: null });
    res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; HttpOnly');
  }
  return { sid, sess: sessions.get(sid) };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

/* ============================================================
 * 页面
 * ============================================================ */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Lab 短信平台 - 登录</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei";background:#f2f4f7;display:flex;height:100vh;margin:0;align-items:center;justify-content:center}
  .box{background:#fff;padding:28px 30px;border-radius:12px;box-shadow:0 6px 24px rgba(20,30,50,.1);width:330px}
  h2{margin:0 0 18px;font-size:17px;color:#1b2129}
  label{display:block;font-size:12px;color:#5b6673;margin:10px 0 4px}
  input{width:100%;height:34px;border:1px solid #e2e6ec;border-radius:7px;padding:0 9px;font-size:13px;box-sizing:border-box;outline:none}
  input:focus{border-color:#2563eb}
  .cap{display:flex;gap:8px;align-items:center}
  .cap img{height:25px;border:1px solid #e2e6ec;border-radius:4px;cursor:pointer}
  button{width:100%;height:36px;margin-top:16px;background:#2563eb;color:#fff;border:0;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer}
  #msg{margin-top:12px;font-size:12px;color:#dc2626;min-height:16px;word-break:break-all}
</style></head><body>
<div class="box">
  <h2>短信平台控制台 · 登录</h2>
  <label>账号</label><input id="u" autocomplete="username">
  <label>密码</label><input id="p" type="password" autocomplete="current-password">
  <label>验证码</label>
  <div class="cap"><input id="c" style="flex:1"><img id="cap" src="/captcha" title="点击刷新"></div>
  <button id="go">登 录</button>
  <div id="msg"></div>
</div>
<script>
  const $ = (s) => document.querySelector(s);
  $('#cap').onclick = () => { $('#cap').src = '/captcha?t=' + Date.now(); };
  $('#go').onclick = async () => {
    const r = await fetch('/api/login2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#u').value, password: $('#p').value, vercode: $('#c').value })
    });
    const j = await r.json();
    if (j.code === 0) { location.href = '/dashboard'; return; }
    $('#msg').textContent = j.msg + (j.need_email_verify ? '（需要邮箱验证）' : '');
    if (j.msg && j.msg.indexOf('验证码') >= 0) $('#cap').src = '/captcha?t=' + Date.now();
  };
</script></body></html>`;

/* ============================================================
 * 路由
 * ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const path = url.pathname;
  const { sid, sess } = ensureSession(req, res);

  if (path === '/' || path === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  if (path === '/captcha') {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    sess.captcha = code;
    const png = makeCaptcha(code);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store',
    });
    return res.end(png);
  }

  if (path === '/api/login2' && req.method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const vercode = body.vercode == null ? '' : String(body.vercode).trim();

    // 弱点 2：验证码为空时直接跳过校验（真实系统里极常见）
    if (vercode && vercode !== sess.captcha) {
      return json(res, 200, { code: 400, msg: '验证码不正确' });
    }
    sess.captcha = String(Math.floor(1000 + Math.random() * 9000));

    const user = USERS.find((u) => u.username === username);
    // 弱点 4：错误信息可枚举用户名
    if (!user) return json(res, 200, { code: 401, msg: '用户不存在' });
    if (user.password !== password) return json(res, 200, { code: 401, msg: '密码错误' });

    sess.username = user.username;
    return json(res, 200, { code: 0, msg: 'ok', need_email_verify: false });
  }

  if (path === '/dashboard') {
    if (!sess.username) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    const u = USERS.find((x) => x.username === sess.username);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>控制台 - ${u.username}</title>
<style>body{font-family:system-ui,"Microsoft YaHei";background:#f2f4f7;padding:40px;color:#1b2129}
.card{background:#fff;padding:24px;border-radius:12px;max-width:620px;box-shadow:0 6px 24px rgba(20,30,50,.08)}
h2{margin:0 0 14px;font-size:17px}table{border-collapse:collapse;width:100%;font-size:13px}
td{padding:6px 8px;border-bottom:1px solid #eef1f5}td:first-child{color:#5b6673;width:110px}
.flag{margin-top:16px;padding:12px;background:#eaf1fe;border-radius:8px;font-family:monospace;font-size:13px;color:#185FA5}</style>
</head><body><div class="card"><h2>登录成功 · 短信平台控制台</h2>
<table>
<tr><td>账号</td><td>${u.username}</td></tr>
<tr><td>角色</td><td>${u.role}</td></tr>
<tr><td>邮箱</td><td>${u.email}</td></tr>
<tr><td>余额</td><td>${u.balance} 条</td></tr>
</table>
<div class="flag">${u.role === 'admin' ? FLAG : '非管理员账号，无 flag'}</div>
</div></body></html>`);
  }

  // 弱点 5：未鉴权的用户列表
  if (path === '/api/users') {
    return json(res, 200, {
      code: 0,
      data: USERS.map((u) => ({ id: u.id, username: u.username, role: u.role, email: u.email, balance: u.balance })),
    });
  }

  // 弱点 3 的观察点：没有任何失败次数限制
  if (path === '/api/ping') return json(res, 200, { code: 0, pong: true });

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 404, msg: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('本地登录靶场已启动');
  console.log('  http://127.0.0.1:' + PORT);
  console.log('');
  console.log('  账号：admin / 123456   operator / op1234   demo / demo');
  console.log('  弱点：验证码可空值绕过 · 用户名枚举 · /api/users 未鉴权 · 无频率限制');
});
