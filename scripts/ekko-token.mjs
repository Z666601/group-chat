// 从运行中的 Ekko Studio 页面读取其本地存储中的 API Token（不打印明文，只写文件）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 9335;
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekko-token-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: 'ignore' });

try {
  let ver = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {} await sleep(250); }
  if (!ver) throw new Error('Chrome 未就绪');
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8748/' });
  await sleep(4000);

  const res = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({ keys: Object.keys(localStorage), sample: Object.fromEntries(Object.entries(localStorage).map(([k,v])=>[k, typeof v==='string' ? v.length : -1])) })`,
    returnByValue: true,
  });
  console.log('localStorage:', res.result.value);

  const val = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) || '';
        if (/token|auth|apikey|api_key/i.test(k) || /^[A-Za-z0-9_-]{40,}$/.test(v)) out[k] = v;
      }
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const found = JSON.parse(val.result.value || '{}');
  console.log('候选 token 键:', Object.keys(found).join(', ') || '(无)');
  fs.mkdirSync(path.join(ROOT, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'agents', '.ekko-candidates.local.json'), JSON.stringify(found, null, 2));
  console.log('已写入 agents/.ekko-candidates.local.json');
} finally {
  try { chrome.kill(); } catch {}
  await sleep(300);
}
process.exit(0);
