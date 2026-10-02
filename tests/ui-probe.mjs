// 确定性 UI 验证：无头 Chrome + CDP，不依赖窗口焦点
// 用法：node tests/ui-probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}
const PORT = 9223;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-probe-'));
const proc = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp timeout: ' + method)), 15000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)));
        else resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

async function main() {
  // 等 devtools 端点就绪
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await res.json();
      if (targets.length) break;
    } catch {}
    await sleep(300);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });

  let evaled;
  await cdpSend(ws, 1, 'Page.enable');
  await cdpSend(ws, 2, 'Page.navigate', { url: 'http://127.0.0.1:8787/' });
  await sleep(5000); // 等 autologin + enterApp + refreshGroups

  // 诊断：登录态和群列表
  evaled = await cdpSend(ws, 3, 'Runtime.evaluate', {
    expression: `JSON.stringify({
      authHidden: document.querySelector('#auth-view').hidden,
      me: window.__gcState?.me?.username || null,
      groups: window.__gcState?.groups?.length ?? -1,
      items: document.querySelectorAll('.group-item').length,
    })`,
    returnByValue: true,
  });
  console.log('诊断:', evaled.result.value);

  // 进群
  evaled = await cdpSend(ws, 4, 'Runtime.evaluate', {
    expression: `(() => { const b = document.querySelector('.group-item'); if (b) { b.click(); return 'clicked'; } return 'no-group-item'; })()`,
    returnByValue: true,
  });
  console.log('进群:', evaled.result.value);
  await sleep(2500);

  // 验证
  evaled = await cdpSend(ws, 5, 'Runtime.evaluate', {
    expression: `JSON.stringify({
      msgs: document.querySelectorAll('.msg').length,
      actions: document.querySelectorAll('.msg-actions').length,
      quotes: document.querySelectorAll('.quote-block').length,
      hook: typeof window.__gcState,
      s129replyTo: !!((window.__gcState?.messages.get(window.__gcState.currentGroupId)) || []).find((m) => m.seq === 129 && m.replyTo),
      memberBadges: document.querySelectorAll('.member-status').length,
      searchEnabled: !document.querySelector('#search-input')?.disabled,
    })`,
    returnByValue: true,
  });
  console.log('页面状态:', evaled.result.value);

  // 引用块的完整 HTML（如果有）
  evaled = await cdpSend(ws, 5, 'Runtime.evaluate', {
    expression: `document.querySelector('.quote-block')?.outerHTML || '(无quote块)'`,
    returnByValue: true,
  });
  console.log('quote块样例:', String(evaled.result.value).slice(0, 300));

  ws.close();
  proc.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('探针失败:', e.message);
  try { proc.kill(); } catch {}
  process.exit(1);
});
