// 校验「成员面板里每个 Agent 都有模型下拉栏」，并做一次真实切换
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const PORT = 9336;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
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
}

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-modelui-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });

try {
  const login = await fetch(APP + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'app_owner', password: 'app_owner_pass_123' }),
  }).then((r) => r.json());
  const token = login.token;

  let ver = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {} await sleep(250); }
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: APP + '/' });
  await sleep(700);
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('gc_token', ${JSON.stringify(token)}); location.reload();` });
  await sleep(2200);

  // 选中演示群
  await cdp.send('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('.group-item'); if(b) b.click();})()` });
  await sleep(1500);
  // 打开成员面板
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btn-toggle-members').click()` });
  await sleep(800);

  const dump = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      memberCount: document.querySelectorAll('.member-item').length,
      selects: [...document.querySelectorAll('.model-select')].map(s => ({ id: s.id, value: s.value, options: s.options.length, disabled: s.disabled, first3: [...s.options].slice(0,3).map(o=>o.textContent) })),
      notApplicable: [...document.querySelectorAll('.member-model.na')].map(e => e.textContent)
    })`,
    returnByValue: true,
  });
  console.log('下拉栏检查:', dump.result.value);

  // 真实切换一次：把 AutoClaw 的模型设为目录中的某个值
  const cat = await fetch(APP + '/api/models', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const pick = (cat.models || []).find((m) => m.id === 'gpt-5.5') || (cat.models || [])[0];
  const changed = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const s = document.querySelector('#model-autoclaw');
      if (!s) return 'no-select';
      const opt = [...s.options].find(o => o.value === ${JSON.stringify(pick.id)});
      if (!opt) return 'no-option';
      s.value = ${JSON.stringify(pick.id)};
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'changed-to-' + s.value;
    })()`,
    returnByValue: true,
  });
  console.log('界面切换动作:', changed.result.value);
  await sleep(1800);

  const after = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({ autoclawValue: (document.querySelector('#model-autoclaw')||{}).value, toast: document.getElementById('toasts').textContent })`,
    returnByValue: true,
  });
  console.log('切换后界面:', after.result.value);

  const server = await fetch(APP + '/api/groups/' + (await fetch(APP + '/api/groups', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())).groups.find((g) => g.name === '多智能体讨论组（演示）').id, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  console.log('服务端落库:', server.members.filter((m) => m.kind === 'agent').map((m) => `${m.displayName}=${m.model || '默认'}`).join(' | '));

  // 截图成员面板
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const out = path.join(ROOT, 'docs', 'screenshots', '07-agent-model-dropdown.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', out, fs.statSync(out).size, 'bytes');
} finally {
  try { chrome.kill(); } catch {}
  await sleep(300);
}
process.exit(0);
