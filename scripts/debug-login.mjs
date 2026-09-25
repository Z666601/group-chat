// 调试：真实点击登录按钮，抓控制台错误与最终状态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = 'http://127.0.0.1:8787';
const PORT = 9337;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-login-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

try {
  let ver = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {} await sleep(250); }
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  // 清掉可能残留的 token
  await cdp.send('Page.navigate', { url: APP + '/' });
  await sleep(900);
  await cdp.send('Runtime.evaluate', { expression: `localStorage.removeItem('gc_token'); location.reload();` });
  await sleep(1800);
  cdp.drain();

  // 填表并提交（模拟真实点击）
  const fill = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const u = document.getElementById('f-username');
      const p = document.getElementById('f-password');
      if (!u || !p) return 'missing-fields';
      u.value = 'app_owner';
      p.value = 'app_owner_pass_123';
      document.getElementById('auth-form').requestSubmit();
      return 'submitted';
    })()`,
    returnByValue: true,
  });
  console.log('提交动作:', fill.result.value);
  await sleep(2500);

  const state = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      authHidden: document.getElementById('auth-view').hidden,
      appHidden: document.getElementById('app-view').hidden,
      error: document.getElementById('auth-error').textContent,
      toasts: document.getElementById('toasts').textContent,
      groupTitle: document.getElementById('group-title').textContent
    })`,
    returnByValue: true,
  });
  console.log('最终状态:', state.result.value);

  const evs = cdp.drain();
  const exceptions = evs.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  const consoleErrs = evs.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  const apiCalls = evs.filter((e) => e.method === 'Network.responseReceived' && e.params.response.url.includes('/api/'))
    .map((e) => ({ url: e.params.response.url, status: e.params.response.status }));
  console.log('\n未捕获异常:', JSON.stringify(exceptions, null, 2));
  console.log('控制台错误:', JSON.stringify(consoleErrs, null, 2));
  console.log('API 调用:', JSON.stringify(apiCalls, null, 2));
} finally {
  try { chrome.kill(); } catch {}
  await sleep(300);
}
process.exit(0);
