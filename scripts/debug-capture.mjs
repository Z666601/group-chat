// 调试脚本：抓取前端的控制台错误与 /api 请求状态，用于定位交互缺陷
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const PORT = 9334;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(APP + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  drain() { const e = this.events; this.events = []; return e; }
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-debug-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });

try {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'demo_alice', password: 'password123' }) });
  const token = login.data.token;
  console.log('登录:', login.status);

  let ver = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {} await sleep(250); }
  console.log('浏览器:', ver?.Browser);

  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  await cdp.send('Page.navigate', { url: APP + '/' });
  await sleep(800);
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('gc_token', ${JSON.stringify(token)}); location.reload();` });
  await sleep(2000);
  cdp.drain();

  // 点击第一个群
  const clicked = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const b=document.querySelector('.group-item'); if(!b) return 'no-group-item'; b.click(); return 'clicked';})()`,
    returnByValue: true,
  });
  console.log('点击群:', clicked.result.value);
  await sleep(1800);

  const state = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.getElementById('group-title').textContent,
      meta: document.getElementById('group-meta').textContent,
      toasts: document.getElementById('toasts').textContent,
      messages: document.querySelectorAll('.msg').length,
      memberItems: document.querySelectorAll('.member-item').length,
      composerDisabled: document.getElementById('composer-input').disabled,
      emptyVisible: !document.getElementById('messages-empty').hidden,
      emptyText: document.getElementById('messages-empty').textContent
    })`,
    returnByValue: true,
  });
  console.log('页面状态:', state.result.value);

  const evs = cdp.drain();
  const consoleErrs = evs.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  const exceptions = evs.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  const apiCalls = evs.filter((e) => e.method === 'Network.responseReceived')
    .map((e) => ({ url: e.params.response.url, status: e.params.response.status }))
    .filter((x) => x.url.includes('/api/'));
  const failed = evs.filter((e) => e.method === 'Network.loadingFailed').map((e) => e.params.errorText);

  console.log('\n控制台错误/警告:', JSON.stringify(consoleErrs, null, 2));
  console.log('未捕获异常:', JSON.stringify(exceptions, null, 2));
  console.log('API 调用:', JSON.stringify(apiCalls, null, 2));
  console.log('加载失败:', JSON.stringify(failed, null, 2));
} finally {
  try { chrome.kill(); } catch {}
  await sleep(300);
}

process.exit(0);
