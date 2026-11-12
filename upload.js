#!/usr/bin/env node
/**
 * 一键上传到 GitHub
 *   node upload.js
 *
 * 需要的只有一个 GitHub Personal Access Token。
 * 脚本会自动：探测代理 → 取用户名 → 建仓库 → 推送 → 清除本地残留 token
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const readline = require('readline');
const path = require('path');

const ROOT = __dirname;
const REPO_NAME = process.argv[2] || 'browser-agent';
const REPO_DESC = 'LLM browser agent extension (CDP) + local login lab';

const PROXIES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:10808',
  'http://127.0.0.1:1080',
];

let TOKEN = '';
let PROXY = null;
let LOGIN = '';

function log(msg) {
  process.stdout.write(msg + '\n');
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/**
 * 探测某个代理（null = 直连）能否打开 github.com。
 * 注意两点：
 *   1. 探针必须是 github.com，不是 api.github.com —— 这两条路的分流规则经常不同
 *   2. 不能用 -o /dev/null，Windows 的 curl 会去写 \dev\null 然后报错
 */
function probeGithub(proxy) {
  const args = ['-s', '-m', '8'];
  if (proxy) args.push('--proxy', proxy);
  else args.push('--noproxy', '*');
  args.push('https://github.com/robots.txt');
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 15000 });
    return /User-agent|Disallow|Allow/i.test(out);
  } catch (e) {
    return false;
  }
}

/** 探测能上 GitHub 的通道：先试直连，再试常见代理端口 */
function detectProxy() {
  log('[1/6] 检测网络…');
  if (probeGithub(null)) {
    log('      直连可用');
    return null;
  }
  for (const p of PROXIES) {
    if (probeGithub(p)) {
      log('      使用代理 ' + p);
      return p;
    }
  }
  return undefined; // 全都不通
}

/** 调 GitHub API */
function api(pathname, method, body) {
  const args = [
    '-s', '-m', '40',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: browser-agent-uploader',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-X', method || 'GET',
    '-w', '\n__STATUS__%{http_code}',
    'https://api.github.com' + pathname,
  ];
  if (PROXY) args.unshift('--proxy', PROXY);
  else args.unshift('--noproxy', '*');
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));

  let out = '';
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', timeout: 45000 });
  } catch (e) {
    out = (e.stdout || '') + '\n__STATUS__000';
  }
  const idx = out.lastIndexOf('\n__STATUS__');
  const jsonText = idx >= 0 ? out.slice(0, idx) : out;
  const status = idx >= 0 ? Number(out.slice(idx + 11).trim()) : 0;
  let json = null;
  try {
    json = JSON.parse(jsonText);
  } catch (e) { /* 非 JSON */ }
  return { status, json, text: jsonText };
}

function git(args, extraEnv) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
}

(async function main() {
  log('============================================');
  log('  Browser Agent → GitHub');
  log('============================================');
  log('');

  // ---------- 网络 ----------
  const p = detectProxy();
  if (p === undefined) {
    log('');
    log('❌ 连不上 GitHub，也没有可用代理。');
    log('   请先打开你的代理软件，再重新运行本脚本。');
    process.exit(1);
  }
  PROXY = p;

  // ---------- Token ----------
  // 优先读环境变量（CI / 脚本调用），否则交互输入
  TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!TOKEN) {
    log('');
    log('[2/6] 需要你的 GitHub Token（只需一个，用完不留在本地）');
    log('');
    log('  没有的话，30 秒生成一个：');
    log('    1. 打开  https://github.com/settings/tokens/new');
    log('    2. Note 随便写（如 upload），Expiration 选 7 days');
    log('    3. 勾选第一个大项  [x] repo');
    log('    4. 页面拉到最底，点  Generate token');
    log('    5. 复制 ghp_ 开头的那串（只显示一次）');
    log('');
    TOKEN = await ask('  粘贴 Token 后回车: ');
  } else {
    log('');
    log('[2/6] 使用环境变量中的 Token');
  }
  if (!TOKEN) {
    log('没输入，退出。');
    process.exit(1);
  }

  // ---------- 身份 ----------
  log('');
  log('[3/6] 校验 Token…');
  const me = api('/user', 'GET');
  if (me.status === 401) {
    log('❌ Token 无效或已过期（401）。');
    process.exit(1);
  }
  if (me.status !== 200 || !me.json || !me.json.login) {
    log('❌ 取用户信息失败：HTTP ' + me.status + ' ' + (me.text || '').slice(0, 160));
    process.exit(1);
  }
  LOGIN = me.json.login;
  log('      已认证为: ' + LOGIN);

  // ---------- 建仓库 ----------
  log('');
  log('[4/6] 检查仓库 ' + LOGIN + '/' + REPO_NAME + ' …');
  const exist = api('/repos/' + LOGIN + '/' + REPO_NAME, 'GET');
  if (exist.status === 200) {
    log('      仓库已存在，直接推送到它');
  } else {
    const created = api('/user/repos', 'POST', {
      name: REPO_NAME,
      description: REPO_DESC,
      private: false,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    });
    if (created.status !== 201) {
      log('❌ 创建仓库失败：HTTP ' + created.status + ' ' + (created.text || '').slice(0, 200));
      log('   常见原因：同名仓库已存在、Token 没有 repo 权限');
      process.exit(1);
    }
    log('      仓库已创建');
  }

  // ---------- 推送 ----------
  log('');
  log('[5/6] 推送代码…');
  const remoteUrl = 'https://' + LOGIN + ':' + TOKEN + '@github.com/' + LOGIN + '/' + REPO_NAME + '.git';
  const cleanUrl = 'https://github.com/' + LOGIN + '/' + REPO_NAME + '.git';

  try {
    try {
      git(['remote', 'remove', 'origin']);
    } catch (e) { /* 没有 origin */ }
    git(['remote', 'add', 'origin', remoteUrl]);
    git(['branch', '-M', 'main']);

    const env = {};
    if (PROXY) {
      env.HTTPS_PROXY = PROXY;
      env.HTTP_PROXY = PROXY;
      env.https_proxy = PROXY;
      env.http_proxy = PROXY;
    } else {
      // 直连模式：清掉环境里的代理，避免又走回不通的通道
      env.HTTPS_PROXY = '';
      env.HTTP_PROXY = '';
      env.https_proxy = '';
      env.http_proxy = '';
      env.ALL_PROXY = '';
      env.all_proxy = '';
    }
    const out = git(['push', '-u', 'origin', 'main'], env);
    log('      ' + out.trim().split('\n').slice(-1)[0]);
  } catch (e) {
    log('❌ 推送失败:');
    log(String(e.stderr || e.stdout || e.message).slice(0, 600));
    try {
      git(['remote', 'set-url', 'origin', cleanUrl]);
    } catch (_) {}
    process.exit(1);
  } finally {
    // 无论成败，都把 token 从 .git/config 里抹掉
    try {
      git(['remote', 'set-url', 'origin', cleanUrl]);
    } catch (_) {}
  }

  // ---------- 收尾 ----------
  log('');
  log('[6/6] 完成');
  log('');
  log('============================================');
  log('  ✅ https://github.com/' + LOGIN + '/' + REPO_NAME);
  log('============================================');
  log('');
  log('  本地 .git/config 里的 token 已清除。');
  log('  这个 token 已经没用了，可以去设置页删掉：');
  log('    https://github.com/settings/tokens');
  log('');
})().catch((e) => {
  log('意外错误: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
