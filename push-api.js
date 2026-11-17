#!/usr/bin/env node
/**
 * push-api — 用 GitHub Git Data API 直接写远程仓库
 *
 * 为什么需要它：git push 走 github.com，被墙时完全没法用；
 * 但 api.github.com 常常是通的。这个脚本只调 API，不碰 git 协议。
 *
 * 做法：把本地 HEAD 的 tree 原样在远程重建（blob → tree → commit → ref），
 * 因为 blob sha 由内容决定，commit 又指定了 author/committer/date，
 * 重建出来的 sha 与本地一致，两边不会分叉。
 *
 *   GITHUB_TOKEN=xxx node push-api.js [提交信息]
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OWNER = process.env.GH_OWNER || 'moyunql';
const REPO = process.env.GH_REPO || 'browser-agent';
const TOKEN = process.env.GITHUB_TOKEN || '';
const COMMIT_MSG = process.argv[2] || '';

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
};
const log = (s) => process.stdout.write((s || '') + '\n');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 }).trim();
}

let apiCount = 0;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function api(pathname, method, body) {
  const args = [
    '-s', '-m', '40',
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: push-api',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-X', method || 'GET',
    '-w', '\n__S__%{http_code}',
    'https://api.github.com' + pathname,
  ];

  const opts = { encoding: 'utf8', timeout: 60000 };

  if (body) {
    // 必须走 stdin：Windows 命令行上限 32767 字符，
    // 直接把 base64 塞进 -d 参数会让大文件（如 28KB 的 panel.js）上传直接崩掉
    args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
    opts.input = JSON.stringify(body);
  }

  let out = '';
  try {
    out = execFileSync('curl', args, opts);
  } catch (e) {
    out = (e.stdout || '') + '\n__S__000';
  }
  apiCount++;
  const i = out.lastIndexOf('\n__S__');
  const text = i >= 0 ? out.slice(0, i) : out;
  const status = i >= 0 ? Number(out.slice(i + 6).trim()) : 0;
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status, json, text };
}

/** 带重试：HTTP 0 多半是代理抖动，网络类错误重试三次 */
function apiRetry(pathname, method, body, tries) {
  const n = tries || 3;
  let last = null;
  for (let i = 0; i < n; i++) {
    last = api(pathname, method, body);
    if (last.status >= 200 && last.status < 300) return last;
    if (last.status === 401 || last.status === 404 || last.status === 422) return last;
    if (i < n - 1) {
      process.stdout.write('.');
      sleepSync(800 * (i + 1));
    }
  }
  return last;
}

function must(res, what) {
  if (res.status >= 200 && res.status < 300 && res.json) return res.json;
  log(c.red + '  ✖ ' + what + ' 失败：HTTP ' + res.status) ;
  log('    ' + String(res.text || '').replace(/gh[pousr]_[A-Za-z0-9]+/g, 'ghp_***').slice(0, 300));
  process.exit(1);
}

/* ============================================================ */

log('');
log(c.blue + '[1/6]' + c.reset + ' 本地提交');
execFileSync('git', ['add', '-A'], { cwd: ROOT, encoding: 'utf8' });

const dirty = git(['status', '--porcelain']);
if (dirty) {
  const n = dirty.split('\n').length;
  execFileSync('git', ['commit', '-m', COMMIT_MSG || 'chore: update'], { cwd: ROOT, encoding: 'utf8' });
  log('      提交了 ' + n + ' 项变更');
} else {
  log(c.dim + '      工作区干净' + c.reset);
}

const headSha = git(['rev-parse', 'HEAD']);
const treeSha = git(['rev-parse', 'HEAD^{tree}']);
const message = git(['log', '-1', '--format=%B']);
const authorName = git(['log', '-1', '--format=%an']);
const authorEmail = git(['log', '-1', '--format=%ae']);
const authorDate = git(['log', '-1', '--format=%aI']);
const committerName = git(['log', '-1', '--format=%cn']);
const committerEmail = git(['log', '-1', '--format=%ce']);
const committerDate = git(['log', '-1', '--format=%cI']);

log('      HEAD ' + headSha.slice(0, 7) + ' · tree ' + treeSha.slice(0, 7));

log('');
log(c.blue + '[2/6]' + c.reset + ' 读取远程状态');
const refRes = apiRetry('/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main');
if (refRes.status === 404) {
  log(c.red + '  ✖ 远程仓库或 main 分支不存在' + c.reset);
  process.exit(1);
}
const ref = must(refRes, '读取 ref');
const remoteSha = ref.object.sha;
log('      远程 ' + remoteSha.slice(0, 7));

if (remoteSha === headSha) {
  log('');
  log(c.green + '  已是最新，无需推送' + c.reset);
  process.exit(0);
}

const remoteCommit = must(apiRetry('/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteSha), '读取远程 commit');
const remoteTreeSha = remoteCommit.tree.sha;
const remoteTree = must(
  api('/repos/' + OWNER + '/' + REPO + '/git/trees/' + remoteTreeSha + '?recursive=1'),
  '读取远程 tree'
);

log('');
log(c.blue + '[3/6]' + c.reset + ' 对比文件');
const localFiles = git(['ls-tree', '-r', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, p] = line.split('\t');
    const [mode, type, sha] = meta.split(/\s+/);
    return { mode, type, sha, path: p };
  });

const remoteMap = new Map();
for (const t of remoteTree.tree) {
  if (t.type === 'blob') remoteMap.set(t.path, t.sha);
}

const toUpload = localFiles.filter((f) => remoteMap.get(f.path) !== f.sha);
const toDelete = Array.from(remoteMap.keys()).filter((p) => !localFiles.some((f) => f.path === p));

log('      本地 ' + localFiles.length + ' 个文件');
log('      需上传 ' + toUpload.length + ' · 需删除 ' + toDelete.length);
toUpload.slice(0, 10).forEach((f) => log(c.dim + '        + ' + f.path + c.reset));
if (toUpload.length > 10) log(c.dim + '        …还有 ' + (toUpload.length - 10) + ' 个' + c.reset);

log('');
log(c.blue + '[4/6]' + c.reset + ' 上传文件内容');
for (const f of toUpload) {
  // 关键：必须用仓库里的内容（LF），不能用工作区文件（Windows 下是 CRLF）
  // 否则算出来的 blob sha 与 git 记录的对不上，重建出的 tree 就和本地不一致
  const content = execFileSync('git', ['cat-file', 'blob', f.sha], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const res = apiRetry(
    '/repos/' + OWNER + '/' + REPO + '/git/blobs',
    'POST',
    { content: content.toString('base64'), encoding: 'base64' }
  );
  const blob = must(res, '上传 ' + f.path);
  if (blob.sha !== f.sha) {
    log(c.yellow + '      ⚠ ' + f.path + ' sha 不一致（本地 ' + f.sha.slice(0, 7) + ' / 远程 ' + blob.sha.slice(0, 7) + '）' + c.reset);
  } else {
    log(c.dim + '      ✓ ' + f.path + c.reset);
  }
}
log('      ' + toUpload.length + ' 个已完成');

log('');
log(c.blue + '[5/6]' + c.reset + ' 重建 tree');
const entries = toUpload.map((f) => ({ path: f.path, mode: f.mode, type: 'blob', sha: f.sha }));
for (const p of toDelete) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });

const newTree = must(
  api('/repos/' + OWNER + '/' + REPO + '/git/trees', 'POST', {
    base_tree: remoteTreeSha,
    tree: entries,
  }),
  '创建 tree'
);

const aligned = newTree.sha === treeSha;
log('      新 tree ' + newTree.sha.slice(0, 7) + (aligned ? c.green + '  ✔ 与本地一致' + c.reset : c.yellow + '  ⚠ 与本地不一致' + c.reset));

log('');
log(c.blue + '[6/6]' + c.reset + ' 创建 commit 并更新分支');
const commit = must(
  api('/repos/' + OWNER + '/' + REPO + '/git/commits', 'POST', {
    message: message,
    tree: newTree.sha,
    parents: [remoteSha],
    author: { name: authorName, email: authorEmail, date: authorDate },
    committer: { name: committerName, email: committerEmail, date: committerDate },
  }),
  '创建 commit'
);

must(
  api('/repos/' + OWNER + '/' + REPO + '/git/refs/heads/main', 'PATCH', { sha: commit.sha, force: true }),
  '更新分支'
);

log('');
log('============================================');
log(c.green + '  ✅ https://github.com/' + OWNER + '/' + REPO + c.reset);
log('  commit ' + commit.sha.slice(0, 7) + (commit.sha === headSha ? c.green + '  ✔ 与本地完全一致' + c.reset : c.yellow + '  （与本地不一致，开代理后 git pull 对齐）' + c.reset));
log('============================================');
log(c.dim + '  API 调用 ' + apiCount + ' 次' + c.reset);
log('');
