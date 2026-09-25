// 开发工具：用无头 Chrome + CDP 对真实页面截图（无需第三方依赖）
// 用法：node --no-warnings scripts/capture.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = process.env.APP_URL || 'http://127.0.0.1:8787';
const OUT = process.env.OUT_DIR || path.join(ROOT, 'docs', 'screenshots');
const PORT = 9333;
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(APP + p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ── 极简 CDP 客户端 ──────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
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
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-capture-'));

  // 取一个真实会话令牌
  const LOGIN_USER = process.env.CAPTURE_USER || 'app_owner';
  const LOGIN_PASS = process.env.CAPTURE_PASS || 'app_owner_pass_123';
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS }),
  });
  if (login.status !== 200) throw new Error('登录失败，请先运行演示数据脚本: ' + JSON.stringify(login.data));
  const token = login.data.token;
  console.log('已获取会话令牌:', token.slice(0, 12) + '…');

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,960',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    // 等调试端口就绪
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (r.ok) {
          version = await r.json();
          break;
        }
      } catch {
        /* retry */
      }
      await sleep(250);
    }
    if (!version) throw new Error('Chrome 调试端口未就绪');
    console.log('浏览器:', version.Browser);

    const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const shots = [];

    async function capture(name, { desktop = true } = {}) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: desktop ? 1440 : 420,
        height: desktop ? 960 : 860,
        deviceScaleFactor: 1,
        mobile: !desktop,
      });
      await sleep(350);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(OUT, name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      shots.push({ name, file, bytes: fs.statSync(file).size });
      console.log(`  截图 ${name}: ${fs.statSync(file).size} bytes`);
    }

    // 1) 登录页
    await cdp.send('Page.navigate', { url: APP + '/' });
    await cdp.waitEvent('Page.loadEventFired');
    await sleep(600);
    await capture('01-login-desktop');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 860, deviceScaleFactor: 1, mobile: true,
    });
    await sleep(300);
    await capture('02-login-mobile', { desktop: false });

    // 2) 注入会话令牌 → 进入群聊
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('gc_token', ${JSON.stringify(token)}); location.reload();`,
    });
    await sleep(1500);
    await cdp.waitEvent('Page.loadEventFired', 8000).catch(() => {});
    await sleep(900);

    const stateAfterLogin = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ authHidden: document.getElementById('auth-view').hidden, appHidden: document.getElementById('app-view').hidden, title: document.getElementById('group-title').textContent, conn: document.getElementById('conn-state').dataset.state, groups: [...document.querySelectorAll('.group-item-name')].map(e=>e.textContent) })`,
      returnByValue: true,
    });
    console.log('  登录后状态:', stateAfterLogin.result.value);

    // 3) 点开第一个群 → 显示消息
    await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const b=document.querySelector('.group-item'); if(b) b.click(); return !!b;})()`,
      returnByValue: true,
    });
    await sleep(1200);
    const stateAfterGroup = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ title: document.getElementById('group-title').textContent, meta: document.getElementById('group-meta').textContent, messages: document.querySelectorAll('.msg').length, texts: [...document.querySelectorAll('.msg-body')].map(e=>e.textContent).slice(0,4), conn: document.getElementById('conn-state').dataset.state })`,
      returnByValue: true,
    });
    console.log('  群聊状态:', stateAfterGroup.result.value);
    await capture('03-chat-desktop');

    // 4) 成员面板
    await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('btn-toggle-members').click()`,
    });
    await sleep(600);
    const memberState = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ members: [...document.querySelectorAll('.member-item')].map(e=>e.textContent) })`,
      returnByValue: true,
    });
    console.log('  成员面板:', memberState.result.value);
    await capture('04-chat-members');

    // 5) 移动端群聊
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 860, deviceScaleFactor: 1, mobile: true,
    });
    await sleep(500);
    await capture('05-chat-mobile', { desktop: false });

    // 6) 发送一条真实消息并观察状态
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(300);
    const sendResult = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const i=document.getElementById('composer-input'); i.value='这是通过真实界面发送的一条消息。'; i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('composer').requestSubmit(); return 'submitted';})()`,
      returnByValue: true,
    });
    await sleep(1500);
    const afterSend = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ messages: document.querySelectorAll('.msg').length, last: [...document.querySelectorAll('.msg')].slice(-1).map(r=>r.textContent)[0] })`,
      returnByValue: true,
    });
    console.log('  发送结果:', sendResult.result.value, '→', afterSend.result.value);
    await capture('06-chat-after-send');

    fs.writeFileSync(path.join(OUT, 'capture-report.json'), JSON.stringify({
      capturedAt: new Date().toISOString(),
      app: APP,
      browser: version.Browser,
      stateAfterLogin: stateAfterLogin.result.value,
      stateAfterGroup: stateAfterGroup.result.value,
      memberState: memberState.result.value,
      afterSend: afterSend.result.value,
      shots,
    }, null, 2));

    console.log('\n截图完成，共', shots.length, '张 →', OUT);
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
    await sleep(400);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[capture] 失败:', err?.message || err);
  process.exit(1);
});
