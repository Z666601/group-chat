#!/usr/bin/env node
// Qoder 大脑包装器：为群聊桥接器调用本机 Qoder CLI。
// - 自动探测 CLI：优先 qoderclicn（CN 版），其次 qodercli，以及入口分发器 qoder-cn.cmd；
//   每次调用都重新探测，本机装好 CLI 后无需改动任何配置即可生效。
// - 依次尝试常见的一次性提问形式（-p / --prompt / 位置参数），拿到非失败输出即返回。
// - 全部不可用时以非零码退出并输出明确的中文原因，桥接器会把它作为「无法应答」说明发进群里。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const argPrompt = process.argv.slice(2).join(' ').trim();
let stdinPrompt = '';
try { stdinPrompt = fs.readFileSync(0, 'utf8').trim(); } catch {}
const prompt = argPrompt || stdinPrompt;
if (!prompt) {
  process.stderr.write('Qoder 大脑：未收到提示词\n');
  process.exit(2);
}

const FAILURE_PATTERNS = [
  /not installed|未安装/i,
  /not logged in|未登录|请先登录/i,
  /Usage:/,
  /unknown option|Unknown option/,
  /API call failed|Connection error/i,
  /is not recognized|无法将.*项识别/i,
];

function looksLikeFailure(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return FAILURE_PATTERNS.some((re) => re.test(t));
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function which(name) {
  const exts = process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat'];
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const p = path.join(dir, name + ext);
      if (exists(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

const candidates = [
  path.join(home, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe'),
  path.join(home, '.qoder-cn', 'bin', 'qodercli', 'qodercli.exe'),
  which('qoderclicn'),
  which('qodercli'),
  path.join(home, '.qoder-cn', 'entry', 'qoder-cn.cmd'),
].filter(Boolean);

if (!candidates.length) {
  process.stderr.write('Qoder 大脑：本机未找到 qodercli/qoderclicn（CLI 未安装）\n');
  process.exit(3);
}

const ARG_FORMS = [
  // 禁用全部内置工具：群聊应答只需要文本，避免模型在会话目录里执行命令
  (p) => ['--tools', '', '-p', p],
  (p) => ['-p', p],
  (p) => ['--prompt', p],
  (p) => [p],
];

function run(cli, argv, timeoutMs) {
  return new Promise((resolve) => {
    // Node 拒绝直接 spawn .cmd/.bat（EINVAL），经 cmd.exe 转发
    const isScript = /\.(cmd|bat)$/i.test(cli);
    const child = isScript
      ? spawn('cmd.exe', ['/d', '/s', '/c', cli, ...argv], { windowsHide: true, env: process.env, windowsVerbatimArguments: false })
      : spawn(cli, argv, { windowsHide: true, env: process.env });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch {} done = true; resolve({ ok: false, err: 'timeout' }); }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => { if (!done) { clearTimeout(timer); done = true; resolve({ ok: false, err: String(e.message || e) }); } });
    child.on('close', (code) => {
      if (done) return;
      clearTimeout(timer);
      done = true;
      resolve({ ok: code === 0, out, err, code });
    });
    try { child.stdin.end(); } catch {}
  });
}

const NOT_INSTALLED_RE = /CLI is not installed|not installed/i;

for (const cli of candidates) {
  for (const form of ARG_FORMS) {
    const r = await run(cli, form(prompt), 150000);
    const text = stripAnsi(r.out || '');
    if (r.ok && !looksLikeFailure(text)) {
      process.stdout.write(text.trim() + '\n');
      process.exit(0);
    }
    // 分发器明确说 CLI 未安装：换候选无意义，直接给出原因
    if (NOT_INSTALLED_RE.test(r.out || '') || NOT_INSTALLED_RE.test(r.err || '')) {
      process.stderr.write('Qoder 大脑：qodercli 未安装（分发器返回 "QoderCN CLI is not installed"）\n');
      process.exit(3);
    }
  }
}

process.stderr.write('Qoder 大脑：已找到候选 CLI 但均未能给出有效回答（未安装/未登录或参数不兼容）\n');
process.exit(4);

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}
