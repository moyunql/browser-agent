#!/usr/bin/env node
/**
 * ghup — 项目上传 Agent
 *
 * 不是无脑 git push，它在推之前会先审一遍：
 *   1. 识别项目类型、文件规模
 *   2. 扫敏感信息（key / token / 私钥 / 密码 / 连接串）—— 命中就拦
 *   3. 检查不该传的东西（node_modules、大文件、依赖目录）
 *   4. 缺 .gitignore / README 就自动补一份
 *   5. 建仓库、提交、推送，然后把 token 从本地抹掉
 *
 * 用法：
 *   node ghup.js                       当前目录
 *   node ghup.js ./my-project          指定目录
 *   node ghup.js ./p --repo name       指定仓库名
 *   node ghup.js ./p --private         建私有仓库
 *   node ghup.js ./p --desc "一句话"   仓库描述
 *   node ghup.js ./p --dry-run         只体检，不推送
 *   node ghup.js ./p --allow-secrets   无视敏感告警强行推（危险）
 *
 * Token：首次输入后缓存在 ~/.ghup/config.json，下次自动用。
 *        也可以用 GITHUB_TOKEN 环境变量覆盖。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const readline = require('readline');

const CONFIG_DIR = path.join(os.homedir(), '.ghup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const PROXIES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:10808',
  'http://127.0.0.1:1080',
];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
};
const c = (col, s) => C[col] + s + C.reset;
const log = (s) => process.stdout.write((s == null ? '' : s) + '\n');
const step = (n, total, s) => log('\n' + c('blue', '[' + n + '/' + total + ']') + ' ' + s);

/* ============================================================
 * 参数
 * ============================================================ */
function parseArgs(argv) {
  const a = {
    dir: '.', repo: '', desc: '', private: false,
    allowSecrets: false, dryRun: false, noPush: false, yes: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--private') a.private = true;
    else if (v === '--allow-secrets') a.allowSecrets = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--no-push') a.noPush = true;
    else if (v === '-y' || v === '--yes') a.yes = true;
    else if (v === '--repo') a.repo = argv[++i] || '';
    else if (v === '--desc') a.desc = argv[++i] || '';
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!v.startsWith('-')) rest.push(v);
    else log(c('yellow', '忽略未知参数: ' + v));
  }
  if (rest[0]) a.dir = rest[0];
  return a;
}

/* ============================================================
 * 敏感信息规则
 * level: block = 必须处理才让过，warn = 仅提示
 * ============================================================ */
const SECRET_RULES = [
  { level: 'block', name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { level: 'block', name: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { level: 'block', name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { level: 'block', name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { level: 'block', name: 'Slack Token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { level: 'block', name: '私钥文件内容', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { level: 'block', name: '数据库连接串（含密码）', re: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"@/]+:[^\s'"@/]+@/g },
  { level: 'block', name: 'Authorization 头', re: /Authorization['"]?\s*[:=]\s*['"]?(?:Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{16,}/gi },
  { level: 'warn', name: '硬编码密码', re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi },
  { level: 'warn', name: 'IP 加端口', re: /\b(?!127\.0\.0\.1|0\.0\.0\.0|localhost)(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g },
];

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'dist', 'build', 'out', 'target',
  'venv', '.venv', 'env', '__pycache__', '.next', '.nuxt', '.svelte-kit',
  'vendor', '.idea', '.vscode', '.vs', 'coverage', '.nyc_output', '.cache',
  '.pytest_cache', '.mypy_cache', 'Pods', 'DerivedData', '.gradle', '.mvn',
]);

const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.md', '.txt', '.rst', '.env', '.example',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.php', '.rb', '.pl', '.lua',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.m', '.scala',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.psm1',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.sql', '.graphql', '.proto',
  '.xml', '.gradle', '.dockerfile', '.gitignore', '.npmrc',
  // 密钥类文件——最该扫的，别漏
  '.pem', '.key', '.crt', '.cer', '.p12', '.pfx', '.jks', '.keystore', '.asc', '.gpg', '.ppk',
]);

const MAX_SCAN_BYTES = 2 * 1024 * 1024;    // 超过 2MB 不扫内容
const BIG_FILE_WARN = 30 * 1024 * 1024;    // 30MB 提示
const BIG_FILE_BLOCK = 90 * 1024 * 1024;   // 90MB 拦（GitHub 单文件 100MB 上限）

/* ============================================================
 * 工具函数
 * ============================================================ */
function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve((a || '').trim()); });
  });
}

function humanSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

function run(bin, args, opts) {
  return execFileSync(bin, args, Object.assign({ encoding: 'utf8', timeout: 180000 }, opts || {}));
}

/* ============================================================
 * 遍历项目
 * ============================================================ */
function walk(root) {
  const files = [];
  const stack = [''];
  const seen = new Set();

  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        const full = path.join(root, childRel);
        let st;
        try {
          st = fs.statSync(full);
        } catch (err) {
          continue;
        }
        const real = path.resolve(full);
        if (seen.has(real)) continue;
        seen.add(real);
        files.push({ rel: childRel.replace(/\\/g, '/'), abs: full, size: st.size, ext: path.extname(e.name).toLowerCase() });
      }
    }
  }
  return files;
}

function isTextFile(f) {
  if (TEXT_EXT.has(f.ext)) return true;
  const base = path.basename(f.rel).toLowerCase();
  if (['dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile'].includes(base)) return true;
  if (base.startsWith('.env')) return true;
  if (base.startsWith('.git')) return true;
  return false;
}

/* ============================================================
 * 项目类型识别
 * ============================================================ */
function detectStack(files) {
  const has = (name) => files.some((f) => f.rel === name || f.rel.endsWith('/' + name));
  const exts = new Set(files.map((f) => f.ext));

  if (has('package.json')) {
    if (has('next.config.js') || has('next.config.mjs')) return 'Next.js';
    if (has('vite.config.js') || has('vite.config.ts')) return 'Vite';
    if (has('tsconfig.json')) return 'Node.js + TypeScript';
    return 'Node.js';
  }
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) {
    if (has('manage.py')) return 'Django';
    if (has('app.py') || has('main.py')) return 'Python';
    return 'Python';
  }
  if (has('go.mod')) return 'Go';
  if (has('Cargo.toml')) return 'Rust';
  if (has('pom.xml')) return 'Java (Maven)';
  if (has('build.gradle') || has('build.gradle.kts')) return 'Java / Kotlin (Gradle)';
  if (has('composer.json')) return 'PHP';
  if (has('Gemfile')) return 'Ruby';
  if (has('pubspec.yaml')) return 'Flutter / Dart';
  if (has('index.html')) return '静态站点';
  if (exts.has('.py')) return 'Python';
  if (exts.has('.js') || exts.has('.ts')) return 'JavaScript';
  return '通用项目';
}

function gitignoreFor(stack) {
  const common = [
    '# 依赖',
    'node_modules/',
    '',
    '# 构建产物',
    'dist/', 'build/', 'out/', '.next/', '.nuxt/',
    '',
    '# 日志',
    '*.log', 'npm-debug.log*', 'yarn-error.log*',
    '',
    '# 环境配置',
    '.env', '.env.local', '.env.*.local',
    '',
    '# 系统文件',
    '.DS_Store', 'Thumbs.db', 'desktop.ini',
    '',
    '# 编辑器',
    '.idea/', '.vscode/',
  ];
  const extra = {
    Python: ['__pycache__/', '*.py[cod]', 'venv/', '.venv/', '.pytest_cache/', '*.egg-info/'],
    Django: ['__pycache__/', '*.py[cod]', 'venv/', '.venv/', 'db.sqlite3', 'media/', 'staticfiles/'],
    Go: ['*.exe', '*.test', '*.out', 'vendor/'],
    Rust: ['target/'],
    'Java (Maven)': ['target/', '*.class'],
    'Java / Kotlin (Gradle)': ['.gradle/', 'build/', '*.class'],
    PHP: ['vendor/', 'composer.lock'],
    Ruby: ['vendor/bundle/', '.bundle/'],
  }[stack] || [];
  return common.concat(extra).join('\n') + '\n';
}

function readmeFor(repo, desc, stack, files) {
  const dirs = Array.from(new Set(files.map((f) => f.rel.split('/')[0]).filter((d) => files.some((x) => x.rel.includes('/'))))).slice(0, 12);
  const startCmd = {
    'Node.js': 'npm install\nnpm start',
    'Node.js + TypeScript': 'npm install\nnpm run dev',
    'Next.js': 'npm install\nnpm run dev',
    'Vite': 'npm install\nnpm run dev',
    Python: 'pip install -r requirements.txt\npython main.py',
    Django: 'pip install -r requirements.txt\npython manage.py runserver',
    Go: 'go mod tidy\ngo run .',
    Rust: 'cargo run',
    'Java (Maven)': 'mvn install\nmvn exec:java',
    'Java / Kotlin (Gradle)': './gradlew build',
    PHP: 'composer install\nphp -S localhost:8000',
    Ruby: 'bundle install\nruby app.rb',
    'Flutter / Dart': 'flutter pub get\nflutter run',
    '静态站点': '直接用浏览器打开 index.html，或起个静态服务器',
  }[stack] || '';

  return [
    '# ' + repo,
    '',
    desc || (stack + ' 项目'),
    '',
    '## 快速开始',
    '',
    '```bash',
    startCmd,
    '```',
    '',
    '## 目录',
    '',
    '```',
    repo + '/',
  ]
    .concat(dirs.map((d) => '├── ' + d + '/'))
    .concat(['└── README.md', '```', '', '## License', '', 'MIT'])
    .join('\n') + '\n';
}

/* ============================================================
 * 敏感扫描
 * ============================================================ */
function scanSecrets(root, files) {
  const hits = [];
  for (const f of files) {
    if (f.size > MAX_SCAN_BYTES) continue;

    let text;
    if (isTextFile(f)) {
      try {
        text = fs.readFileSync(f.abs, 'utf8');
      } catch (e) {
        continue;
      }
    } else {
      // 兜底：扩展名不认识的小文件也扫一遍（无扩展名的密钥文件很常见）
      // 判据是"不含 NUL 字节"，二进制文件会被跳过
      if (f.size > 300 * 1024) continue;
      let buf;
      try {
        buf = fs.readFileSync(f.abs);
      } catch (e) {
        continue;
      }
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    }

    const lines = text.split('\n');
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      let m;
      let guard = 0;
      while ((m = rule.re.exec(text)) !== null && guard++ < 50) {
        const idx = m.index;
        const line = text.slice(0, idx).split('\n').length;
        const lineText = lines[line - 1] || '';
        const masked = lineText.length > 90 ? lineText.slice(0, 90) + '…' : lineText;
        hits.push({
          level: rule.level,
          rule: rule.name,
          file: f.rel,
          line,
          sample: masked.replace(/([A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]{8,}/g, '$1***'),
        });
        if (m[0].length === 0) break;
      }
    }
  }
  return hits;
}

/* ============================================================
 * 网络与 GitHub API
 * ============================================================ */
let PROXY = null;

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

function detectProxy() {
  if (probeGithub(null)) return null;
  for (const p of PROXIES) if (probeGithub(p)) return p;
  return undefined;
}

function api(pathname, method, body, token) {
  const args = [
    '-s', '-m', '40',
    '-H', 'Authorization: Bearer ' + token,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: ghup',
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
  try { json = JSON.parse(jsonText); } catch (e) { /* 非 JSON */ }
  return { status, json, text: jsonText };
}

/* ============================================================
 * Token 缓存
 * ============================================================ */
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && cfg.token) return cfg.token;
  } catch (e) { /* 没有缓存 */ }
  return '';
}

function saveToken(token) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
    log(c('dim', '      Token 已缓存到 ' + CONFIG_FILE + '（下次不用再输）'));
  } catch (e) {
    log(c('yellow', '      Token 缓存失败（不影响本次上传）'));
  }
}

/* ============================================================
 * 主流程
 * ============================================================ */
const TOTAL = 7;

(async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    log('用法: node ghup.js [目录] [--repo 名称] [--private] [--desc "描述"]');
    log('        [--dry-run] [--allow-secrets] [--no-push] [-y]');
    return;
  }

  const root = path.resolve(args.dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    log(c('red', '目录不存在: ' + root));
    process.exit(1);
  }

  const repo = args.repo || path.basename(root).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase();

  log('');
  log(c('bold', '============================================'));
  log(c('bold', '  ghup — 项目上传 Agent'));
  log(c('bold', '============================================'));
  log('  目录: ' + root);
  log('  仓库: ' + repo);

  /* ---------- 1. 扫描 ---------- */
  step(1, TOTAL, '扫描项目…');
  const files = walk(root);
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  const stack = detectStack(files);
  log('      类型: ' + c('cyan', stack));
  log('      文件: ' + files.length + ' 个，共 ' + humanSize(totalSize));

  if (!files.length) {
    log(c('red', '目录是空的，没有可上传的内容。'));
    process.exit(1);
  }

  /* ---------- 2. 大文件与依赖目录 ---------- */
  step(2, TOTAL, '检查不该传的内容…');
  const bigFiles = files.filter((f) => f.size >= BIG_FILE_WARN);
  const fatalFiles = files.filter((f) => f.size >= BIG_FILE_BLOCK);

  if (bigFiles.length) {
    log(c('yellow', '  ⚠ 大文件 ' + bigFiles.length + ' 个:'));
    bigFiles.slice(0, 8).forEach((f) => log('      ' + humanSize(f.size).padStart(9) + '  ' + f.rel));
  }
  if (fatalFiles.length) {
    log(c('red', '  ✖ 超过 90MB，GitHub 会拒收:'));
    fatalFiles.forEach((f) => log('      ' + humanSize(f.size).padStart(9) + '  ' + f.rel));
  }
  if (!bigFiles.length) log(c('green', '  ✔ 没有超大文件'));

  const skippedNames = ['node_modules', 'venv', '.venv', 'dist', 'build', 'target']
    .filter((d) => fs.existsSync(path.join(root, d)));
  if (skippedNames.length) {
    log(c('dim', '  已自动跳过: ' + skippedNames.join(', ')));
  }

  /* ---------- 3. 敏感信息 ---------- */
  step(3, TOTAL, '扫描敏感信息…');
  const hits = scanSecrets(root, files);
  const blocks = hits.filter((h) => h.level === 'block');
  const warns = hits.filter((h) => h.level === 'warn');

  if (blocks.length) {
    log(c('red', '  ✖ 发现 ' + blocks.length + ' 处高危凭据:'));
    blocks.slice(0, 15).forEach((h) => {
      log(c('red', '      [' + h.rule + '] ') + h.file + ':' + h.line);
      log(c('dim', '        ' + h.sample));
    });
    if (blocks.length > 15) log(c('dim', '      …还有 ' + (blocks.length - 15) + ' 处'));
  }
  if (warns.length) {
    log(c('yellow', '  ⚠ 可疑 ' + warns.length + ' 处（可能是测试值）:'));
    warns.slice(0, 8).forEach((h) => log('      [' + h.rule + '] ' + h.file + ':' + h.line));
    if (warns.length > 8) log(c('dim', '      …还有 ' + (warns.length - 8) + ' 处'));
  }
  if (!hits.length) log(c('green', '  ✔ 没扫到密钥、密码或私钥'));

  if (blocks.length && !args.allowSecrets) {
    log('');
    log(c('red', '  已中止上传。') + '先把这些凭据挪到环境变量或配置文件里，');
    log('  并在 .gitignore 里排除那个文件。');
    log('');
    log(c('dim', '  确认这些是假数据 / 测试值，可以加 --allow-secrets 强行上传。'));
    process.exit(2);
  }
  if (fatalFiles.length) {
    log(c('red', '  已中止上传：有文件超过 GitHub 90MB 限制。'));
    process.exit(2);
  }

  /* ---------- 4. 补齐基础文件 ---------- */
  step(4, TOTAL, '检查基础文件…');
  const created = [];
  const planned = [];

  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    if (args.dryRun) {
      planned.push('.gitignore');
      log(c('cyan', '  + 将生成 .gitignore（' + stack + ' 模板）'));
    } else {
      fs.writeFileSync(gitignorePath, gitignoreFor(stack), 'utf8');
      created.push('.gitignore');
      log(c('green', '  + 已生成 .gitignore（' + stack + ' 模板）'));
    }
  } else {
    log(c('dim', '  · .gitignore 已存在，跳过'));
  }

  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) {
    if (args.dryRun) {
      planned.push('README.md');
      log(c('cyan', '  + 将生成 README.md（' + stack + ' 骨架）'));
    } else {
      fs.writeFileSync(readmePath, readmeFor(repo, args.desc, stack, files), 'utf8');
      created.push('README.md');
      log(c('green', '  + 已生成 README.md（' + stack + ' 骨架）'));
    }
  } else {
    log(c('dim', '  · README.md 已存在，跳过'));
  }

  if (args.dryRun) {
    log('');
    log(c('cyan', '--dry-run 模式：只体检，磁盘和仓库都没动。'));
    if (planned.length) log(c('dim', '  真正运行时还会补齐: ' + planned.join(', ')));
    return;
  }

  /* ---------- 5. 本地提交 ---------- */
  step(5, TOTAL, '本地 git 提交…');
  const isRepo = fs.existsSync(path.join(root, '.git'));
  if (!isRepo) {
    run('git', ['init', '-b', 'main'], { cwd: root });
    log('      初始化仓库');
  } else {
    log(c('dim', '      已是 git 仓库'));
  }

  try {
    run('git', ['config', 'user.name'], { cwd: root });
  } catch (e) {
    run('git', ['config', 'user.name', os.userInfo().username || 'user'], { cwd: root });
    run('git', ['config', 'user.email', (os.userInfo().username || 'user') + '@users.noreply.github.com'], { cwd: root });
    log('      已设置默认提交身份（可用 git config 改）');
  }

  run('git', ['add', '-A'], { cwd: root });

  let dirty = '';
  try {
    dirty = run('git', ['status', '--porcelain'], { cwd: root });
  } catch (e) { /* ignore */ }

  if (dirty.trim()) {
    const count = dirty.trim().split('\n').length;
    run('git', ['commit', '-m', 'chore: upload ' + repo + ' (' + stack + ')'], { cwd: root });
    log(c('green', '  ✔ 已提交 ' + count + ' 项变更'));
  } else {
    log(c('dim', '  · 工作区干净，无需提交'));
  }

  run('git', ['branch', '-M', 'main'], { cwd: root });

  if (args.noPush) {
    log('');
    log(c('cyan', '--no-push 模式，本地已就绪，未推送。'));
    return;
  }

  /* ---------- 6. 网络 + 建仓库 ---------- */
  step(6, TOTAL, '连接 GitHub…');
  const p = detectProxy();
  if (p === undefined) {
    log(c('red', '  ✖ 连不上 GitHub，也没有可用代理。先开代理软件。'));
    process.exit(1);
  }
  PROXY = p;
  log('      通道: ' + (p ? p : '直连'));

  let token = loadToken();
  let firstTime = false;
  if (!token) {
    log('');
    log('  需要一个 GitHub Token（只存本地，不会进仓库）：');
    log('  ' + c('cyan', 'https://github.com/settings/tokens/new') + '  → 勾 repo → 生成');
    token = await ask('  粘贴 Token: ');
    if (!token) { log('没输入，退出。'); process.exit(1); }
    firstTime = true;
  }

  const me = api('/user', 'GET', null, token);
  if (me.status === 401) {
    log(c('red', '  ✖ Token 无效或已过期（401）'));
    try { fs.unlinkSync(CONFIG_FILE); } catch (e) {}
    process.exit(1);
  }
  if (me.status !== 200 || !me.json || !me.json.login) {
    log(c('red', '  ✖ 取用户信息失败：HTTP ' + me.status));
    process.exit(1);
  }
  const login = me.json.login;
  log('      身份: ' + c('cyan', login));
  if (firstTime) saveToken(token);

  const exist = api('/repos/' + login + '/' + repo, 'GET', null, token);
  if (exist.status === 200) {
    log('      仓库已存在，将推送到它');
  } else {
    const cr = api('/user/repos', 'POST', {
      name: repo,
      description: args.desc || (stack + ' 项目'),
      private: !!args.private,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    }, token);
    if (cr.status !== 201) {
      log(c('red', '  ✖ 创建仓库失败：HTTP ' + cr.status + ' ' + (cr.text || '').slice(0, 160)));
      process.exit(1);
    }
    log(c('green', '  + 仓库已创建（' + (args.private ? '私有' : '公开') + '）'));
  }

  /* ---------- 7. 推送 ---------- */
  step(7, TOTAL, '推送…');
  const authUrl = 'https://' + login + ':' + token + '@github.com/' + login + '/' + repo + '.git';
  const cleanUrl = 'https://github.com/' + login + '/' + repo + '.git';
  const env = Object.assign({}, process.env);
  if (PROXY) {
    env.HTTPS_PROXY = PROXY; env.HTTP_PROXY = PROXY;
    env.https_proxy = PROXY; env.http_proxy = PROXY;
  } else {
    ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy'].forEach((k) => { env[k] = ''; });
  }

  try {
    try { run('git', ['remote', 'remove', 'origin'], { cwd: root, env }); } catch (e) { /* 没有 origin */ }
    run('git', ['remote', 'add', 'origin', authUrl], { cwd: root, env });
    const out = run('git', ['push', '-u', 'origin', 'main'], { cwd: root, env });
    log('      ' + out.trim().split('\n').filter(Boolean).slice(-1)[0]);
  } catch (e) {
    log(c('red', '  ✖ 推送失败:'));
    log(String(e.stderr || e.stdout || e.message).replace(/gh[pousr]_[A-Za-z0-9]+/g, 'ghp_***').slice(0, 500));
    process.exit(1);
  } finally {
    try { run('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd: root }); } catch (e) {}
  }

  /* ---------- 完成 ---------- */
  log('');
  log(c('bold', '============================================'));
  log(c('green', '  ✅ ' + cleanUrl));
  log(c('bold', '============================================'));
  log('');
  if (created.length) log('  自动补齐: ' + created.join(', ') + c('dim', '（建议看一眼再改）'));
  if (warns.length) log(c('yellow', '  还有 ' + warns.length + ' 处可疑内容，自己确认下是不是测试值'));
  log(c('dim', '  本地 .git/config 里的 token 已清除'));
  log('');
})().catch((e) => {
  log(c('red', '意外错误: ' + (e && e.message ? e.message : String(e))));
  process.exit(1);
});
