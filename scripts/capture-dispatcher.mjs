// 一次性截图：调度台面板 + 成员面板收纳后的状态（复用 capture.mjs 的 CDP 框架）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 9334;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  async waitEvent(method, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      const idx = this.events.findIndex((e) => e.method === method);
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      if (Date.now() - t0 > timeoutMs) throw new Error('waitEvent timeout: ' + method);
      await sleep(50);
    }
  }
}

async function main() {
  const login = await fetch(APP + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'app_owner', password: 'app_owner_pass_123' }),
  }).then((r) => r.json());
  const token = login.token;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
      await sleep(250);
    }
    const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP + '/' });
    await cdp.waitEvent('Page.loadEventFired');
    await sleep(600);
    await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('gc_token', ${JSON.stringify(token)}); location.reload();` });
    await sleep(2200);
    await cdp.send('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('.group-item'); if(b) b.click();})()` });
    await sleep(1400);

    // 调度台面板
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btn-dispatcher').click()` });
    await sleep(1500);
    const st = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const gid = location.pathname; // 占位
        const t = localStorage.getItem('gc_token');
        const groups = await fetch('/api/groups', { headers: { authorization: 'Bearer ' + t } }).then(r => r.json());
        const gid2 = groups.groups?.[0]?.id;
        const r = await fetch('/api/groups/' + gid2 + '/dispatcher', { headers: { authorization: 'Bearer ' + t } });
        const body = await r.text();
        return JSON.stringify({ status: r.status, gid: gid2, head: body.slice(0, 160) });
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    console.log('API 直测:', st.result.value);
    const st2 = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ panelHidden: document.getElementById('dispatcher-panel').hidden, bodyChildren: document.getElementById('dispatcher-body').children.length, trace: (window.__ddTrace||[]).slice(-4) })`,
      returnByValue: true,
    });
    console.log('面板状态:', st2.result.value);
    const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded').slice(-3);
    for (const e of errs) console.log('CONSOLE-ERR:', JSON.stringify(e.params?.exceptionDetails?.exception?.description || e.params?.entry?.text || e.method).slice(0, 300));
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '08-dispatcher-panel.png'), Buffer.from(shot.data, 'base64'));

    // 成员面板（收纳后）
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btn-close-dispatcher').click(); document.getElementById('btn-toggle-members').click()` });
    await sleep(900);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '09-members-compact.png'), Buffer.from(shot.data, 'base64'));
    console.log('完成 → 08-dispatcher-panel.png / 09-members-compact.png');
  } finally {
    try { chrome.kill(); } catch {}
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
