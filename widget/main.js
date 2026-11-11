const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

if (process.argv.includes('--debug-widget')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

const PROBE = process.argv.includes('--probe');
const HWND_FILE = path.join(__dirname, '.hwnd');
const BOUNDS_FILE = path.join(__dirname, '.bounds.json');
const DESKTOP = 'C:\\Users\\34288\\Desktop';

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - 120)),
      y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - 80)),
      width: Math.max(420, Math.min(b.width, wa.width)),
      height: Math.max(420, Math.min(b.height, wa.height)),
    };
  } catch {
    return null;
  }
}

function scanApps() {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'desktop.ini') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !e.name.startsWith('.')) walk(p, depth + 1);
        continue;
      }
      if (!/\.lnk$/i.test(e.name)) continue;
      const name = e.name.replace(/\.lnk$/i, '');
      if (name === '__t' || seen.has(p)) continue;
      seen.add(p);
      out.push({ name, path: p });
    }
  };
  walk(DESKTOP, 0);
  walk(path.join(DESKTOP, '桌面图标'), 0);
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function writeHwnd(win) {
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    fs.writeFileSync(HWND_FILE, JSON.stringify({ hwnd, pid: process.pid }));
  } catch (err) {
    console.error('writeHwnd failed', err);
  }
}

function startZorderKeeper() {
  const candidates = [
    'C:\\Users\\34288\\AppData\\Local\\Programs\\Python\\Python312\\pythonw.exe',
    'pythonw.exe',
  ];
  const exe = candidates.find((p) => p === 'pythonw.exe' || fs.existsSync(p)) || 'pythonw.exe';
  try {
    const child = spawn(exe, [path.join(__dirname, 'zorder_keeper.pyw')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: __dirname,
    });
    child.unref();
  } catch (err) {
    console.error('zorder keeper failed', err);
  }
}

const WIDGET_CSS = `
  :root { --topbar-h: 48px !important; }
  html, body { background: transparent !important; }
  body {
    padding-top: 30px !important;
    border-radius: 18px;
    overflow: hidden;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif !important;
    color: #e6efff;
  }
  body::before, body::after { display: none !important; }
  .sfx-stars, .sfx-hud, .sfx-scan, .sfx-corner, .fx-nebula,
  .fx-channel, .fx-ticker, .fx-halo { display: none !important; }
  #app-view, .app, .layout, .main, .messages, .auth { background: transparent !important; }
  .app { height: calc(100dvh - 30px) !important; }
  .auth { min-height: calc(100dvh - 30px) !important; }

  #wframe {
    position: fixed; inset: 0; z-index: 99997; pointer-events: none;
    border: 1px solid rgba(140, 190, 255, .20);
    border-radius: 18px;
    box-shadow: inset 0 0 44px rgba(40, 80, 180, .07);
  }

  .topbar {
    background: rgba(9, 14, 26, .16) !important;
    border-bottom: 1px solid rgba(140, 190, 255, .12) !important;
    box-shadow: none !important;
  }
  .topbar::after { opacity: .55; }
  .sidebar, .members {
    background: rgba(10, 16, 30, .24) !important;
    border-color: rgba(140, 190, 255, .12) !important;
    box-shadow: none !important;
  }
  .sidebar .me, .sidebar-actions { border-bottom-color: rgba(140, 190, 255, .10) !important; }
  .group-item { border-radius: 10px !important; }
  .group-item[aria-current="true"] {
    background: linear-gradient(90deg, rgba(99, 180, 255, .16), rgba(99, 180, 255, .04)) !important;
    box-shadow: inset 2px 0 #6ea8ff, 0 0 18px -10px rgba(99, 180, 255, .6) !important;
  }
  .member-item { border-radius: 9px; }
  .member-item:hover { background: rgba(120, 180, 255, .06); }

  .messages { padding: 16px 16px 6px !important; }
  .msg {
    grid-template-columns: 34px minmax(0, 1fr) !important;
    gap: 10px !important; padding: 5px 8px !important;
    margin: 0 -8px !important; border-radius: 12px !important;
  }
  .msg.mine { grid-template-columns: minmax(0, 1fr) 34px !important; }
  .msg-avatar { width: 34px !important; height: 34px !important; font-size: 15px !important; }
  .msg-avatar.agent { cursor: pointer; }
  .msg-avatar.agent:hover { box-shadow: 0 0 0 2px rgba(120, 180, 255, .55); }
  .msg-body {
    background: rgba(20, 30, 52, .26) !important;
    border: 1px solid rgba(140, 190, 255, .12) !important;
    border-radius: 14px !important;
    box-shadow: none !important;
    color: #e6efff !important;
    padding: 9px 12px !important;
  }
  .msg.mine .msg-body {
    background: rgba(72, 104, 235, .34) !important;
    border-color: rgba(170, 205, 255, .26) !important;
    box-shadow: 0 6px 20px -14px rgba(80, 120, 255, .8) !important;
  }
  .msg-sender { color: #cfe3ff !important; font-weight: 600; }
  .msg-time { color: rgba(180, 205, 235, .55) !important; }
  .day-sep, .unread-sep { color: rgba(180, 205, 235, .55) !important; }
  .quote-block { background: rgba(0, 0, 0, .14) !important; border-left-color: rgba(170, 205, 255, .5) !important; }

  .composer {
    background: transparent !important;
    border-top: 1px solid rgba(140, 190, 255, .12) !important;
    padding: 8px 12px 12px !important;
  }
  .composer textarea {
    background: rgba(8, 13, 24, .24) !important;
    border: 1px solid rgba(140, 190, 255, .15) !important;
    border-radius: 13px !important;
    color: #e6efff !important;
    padding: 9px 12px !important;
    box-shadow: none !important;
  }
  .composer textarea::placeholder { color: rgba(170, 195, 225, .5) !important; }
  .composer textarea:focus {
    border-color: rgba(120, 180, 255, .55) !important;
    box-shadow: 0 0 0 3px rgba(80, 130, 255, .12) !important;
  }
  .composer .btn-primary {
    background: rgba(74, 112, 255, .38) !important;
    border: 1px solid rgba(160, 205, 255, .55) !important;
    color: #f2f7ff !important;
    border-radius: 11px !important;
    box-shadow: 0 0 16px rgba(80, 130, 255, .30), inset 0 1px 0 rgba(255, 255, 255, .22) !important;
  }
  .composer .btn-primary:hover {
    background: rgba(100, 145, 255, .55) !important;
    box-shadow: 0 0 22px rgba(90, 140, 255, .45) !important;
  }
  .composer .btn-primary:disabled { opacity: .45; box-shadow: none !important; }
  .composer .file-btn {
    background: rgba(8, 13, 24, .20) !important;
    border: 1px solid rgba(140, 190, 255, .14) !important;
    border-radius: 11px !important;
  }
  .composer-note, #btn-logout { display: none !important; }

  .btn { border-radius: 10px !important; }
  .btn-ghost {
    background: rgba(10, 16, 30, .18) !important;
    border-color: rgba(140, 190, 255, .14) !important;
    color: #cfe3ff !important;
  }
  .btn-ghost:hover { background: rgba(70, 110, 220, .22) !important; }

  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-thumb { background: rgba(130, 180, 255, .22); border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }

  .auth-box {
    background: rgba(10, 16, 30, .42) !important;
    border-color: rgba(140, 190, 255, .18) !important;
    backdrop-filter: blur(14px);
  }

  #wbar {
    position: fixed; top: 0; left: 0; right: 0; height: 30px; z-index: 99999;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 7px 0 12px;
    background: rgba(8, 12, 22, .18);
    border-bottom: 1px solid rgba(140, 190, 255, .12);
    border-top-left-radius: 18px; border-top-right-radius: 18px;
    backdrop-filter: blur(10px);
    -webkit-app-region: drag;
  }
  #wbar .wtitle {
    font: 11.5px/1 "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    color: #cfe3ff; letter-spacing: .08em; user-select: none;
    display: flex; align-items: center; gap: 6px;
  }
  #wbar .wtitle::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%;
    background: #6ee7ff; box-shadow: 0 0 8px rgba(110, 231, 255, .8);
  }
  #wbar .wactions { display: flex; gap: 5px; -webkit-app-region: no-drag; }
  #wbar button {
    position: relative;
    background: rgba(10, 16, 30, .28); color: #cfe3ff;
    border: 1px solid rgba(140, 190, 255, .18); border-radius: 9px;
    height: 23px; padding: 0 9px;
    font: 11px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    cursor: pointer;
  }
  #wbar button:hover { background: rgba(70, 110, 220, .32); border-color: rgba(160, 205, 255, .4); }
  #wbar #wctl-close { width: 24px; padding: 0; }
  #wbar #wctl-back[hidden], #wbar #wctl-dm[hidden] { display: none; }
  #wbar #wctl-back { border-color: rgba(99, 230, 255, .35); color: #9fe8ff; }
  #wbar #wctl-dm { border-color: rgba(140, 190, 255, .24); }
  #wdm-badge {
    position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px;
    padding: 0 3px; border-radius: 8px; background: #ff6b8a; color: #fff;
    font: 9px/14px "Microsoft YaHei UI", sans-serif; text-align: center;
    box-shadow: 0 0 8px rgba(255, 107, 138, .6);
  }
  #wdm-badge[hidden] { display: none; }

  #wdm {
    position: fixed; top: 36px; right: 7px; z-index: 99999;
    width: 230px; max-height: 60vh; overflow-y: auto;
    padding: 6px;
    background: rgba(8, 12, 22, .42);
    border: 1px solid rgba(140, 190, 255, .20);
    border-radius: 13px;
    backdrop-filter: blur(14px);
    box-shadow: 0 18px 40px -24px #000;
  }
  #wdm[hidden] { display: none; }
  .wdm-row {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 9px; border-radius: 9px; cursor: pointer;
    color: #dce9ff; font: 12px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
  }
  .wdm-row:hover { background: rgba(70, 110, 220, .22); }
  .wdm-av { width: 22px; text-align: center; font-size: 15px; }
  .wdm-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wdm-un {
    min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
    background: rgba(255, 107, 138, .85); color: #fff;
    font: 9px/16px sans-serif; text-align: center;
  }
  .wdm-un[hidden] { display: none; }

  #wapps {
    position: fixed; top: 36px; right: 7px; z-index: 99999;
    width: 330px; max-width: calc(100vw - 20px); max-height: 62vh; overflow-y: auto;
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px;
    padding: 7px;
    background: rgba(8, 12, 22, .42);
    border: 1px solid rgba(140, 190, 255, .20);
    border-radius: 13px;
    backdrop-filter: blur(14px);
    box-shadow: 0 18px 40px -24px #000;
  }
  #wapps[hidden] { display: none; }
  #wapps .wapp {
    background: rgba(20, 32, 56, .28); color: #dce9ff;
    border: 1px solid rgba(140, 190, 255, .14); border-radius: 9px;
    padding: 7px 8px; font: 11.5px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    text-align: left; cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #wapps .wapp:hover { background: rgba(70, 110, 220, .30); }

  .wrs { position: fixed; z-index: 99998; }
  .wrs-n { top: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
  .wrs-s { bottom: 0; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
  .wrs-e { top: 10px; bottom: 10px; right: 0; width: 5px; cursor: ew-resize; }
  .wrs-w { top: 10px; bottom: 10px; left: 0; width: 5px; cursor: ew-resize; }
  .wrs-ne { top: 0; right: 0; width: 12px; height: 12px; cursor: nesw-resize; }
  .wrs-nw { top: 0; left: 0; width: 12px; height: 12px; cursor: nwse-resize; }
  .wrs-se { bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; }
  .wrs-sw { bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }
`;

const WIDGET_JS = `
(function () {
  if (window.__widgetUi) return;
  window.__widgetUi = true;

  const bar = document.createElement('div');
  bar.id = 'wbar';
  const title = document.createElement('span');
  title.className = 'wtitle';
  title.textContent = '群聊';
  const actions = document.createElement('div');
  actions.className = 'wactions';
  const backBtn = document.createElement('button');
  backBtn.id = 'wctl-back';
  backBtn.textContent = '回群聊';
  backBtn.hidden = true;
  const dmBtn = document.createElement('button');
  dmBtn.id = 'wctl-dm';
  dmBtn.textContent = '私聊';
  const dmBadge = document.createElement('span');
  dmBadge.id = 'wdm-badge';
  dmBadge.hidden = true;
  dmBtn.appendChild(dmBadge);
  const appsBtn = document.createElement('button');
  appsBtn.id = 'wctl-apps';
  appsBtn.textContent = '应用';
  const closeBtn = document.createElement('button');
  closeBtn.id = 'wctl-close';
  closeBtn.textContent = '×';
  actions.append(backBtn, dmBtn, appsBtn, closeBtn);
  bar.append(title, actions);
  document.body.appendChild(bar);

  const frame = document.createElement('div');
  frame.id = 'wframe';
  document.body.appendChild(frame);

  // ── 点头像私聊：私聊群在列表里隐藏，点 agent 头像直接进一对一 ──
  const DM_PREFIX = '私聊·';
  const groupItems = () => [...document.querySelectorAll('#group-list .group-item')];
  const itemName = (el) => (el.querySelector('.group-item-name')?.textContent || '').trim();
  const dmNames = () => groupItems()
    .map(itemName)
    .filter((n) => n.includes(DM_PREFIX))
    .map((n) => n.slice(n.indexOf(DM_PREFIX) + DM_PREFIX.length).trim());
  const findDmItem = (name) => groupItems().find((el) => itemName(el).includes(DM_PREFIX + name));
  const findMainItem = () => groupItems().find((el) => !itemName(el).includes(DM_PREFIX));

  function openDm(name) {
    const item = findDmItem(name);
    if (!item) return;
    const members = document.getElementById('members-panel');
    if (members && !members.hidden) document.getElementById('btn-close-members')?.click();
    item.click();
  }

  backBtn.addEventListener('click', () => findMainItem()?.click());

  function syncDmUi() {
    let visible = 0;
    for (const el of groupItems()) {
      const li = el.closest('li');
      const hide = itemName(el).includes(DM_PREFIX);
      if (li) li.style.display = hide ? 'none' : '';
      if (!hide) visible += 1;
    }
    const cnt = document.getElementById('group-count');
    if (cnt) cnt.textContent = visible ? '(' + visible + ')' : '';
    const titleText = (document.getElementById('group-title')?.textContent || '').trim();
    const wt = document.querySelector('#wbar .wtitle');
    if (wt) wt.textContent = titleText || '群聊';
    const isDm = titleText.includes(DM_PREFIX);
    backBtn.hidden = !isDm;
    document.body.classList.toggle('dm-mode', isDm);
    const input = document.getElementById('composer-input');
    if (input) {
      const dmName = isDm ? titleText.split(DM_PREFIX)[1].trim() : '';
      input.placeholder = isDm ? '和' + dmName + '私聊…' : '输入消息，Enter 发送，Shift+Enter 换行';
    }
  }

  document.addEventListener('click', (e) => {
    const av = e.target.closest('.msg-avatar.agent');
    if (av) {
      const name = (av.closest('.msg')?.querySelector('.msg-sender')?.textContent || '').replace('（我）', '').trim();
      const hit = dmNames().find((n) => name.includes(n));
      if (hit) { e.preventDefault(); e.stopPropagation(); openDm(hit); }
      return;
    }
    const mi = e.target.closest('.member-item');
    if (mi && mi.querySelector('.member-role.agent')) {
      const name = (mi.querySelector('.member-name')?.textContent || '').replace('（我）', '').trim();
      const hit = dmNames().find((n) => name.includes(n));
      if (hit) { e.preventDefault(); e.stopPropagation(); openDm(hit); }
    }
  }, true);

  const list = document.getElementById('group-list');
  if (list) new MutationObserver(syncDmUi).observe(list, { childList: true });
  const titleEl = document.getElementById('group-title');
  if (titleEl) new MutationObserver(syncDmUi).observe(titleEl, { childList: true, characterData: true, subtree: true });
  syncDmUi();

  const panel = document.createElement('div');
  panel.id = 'wapps';
  panel.hidden = true;
  document.body.appendChild(panel);

  appsBtn.addEventListener('click', async () => {
    dmPanel.hidden = true;
    if (!panel.hidden) { panel.hidden = true; return; }
    const apps = await window.widget.getApps();
    panel.replaceChildren();
    for (const a of apps) {
      const b = document.createElement('button');
      b.className = 'wapp';
      b.textContent = a.name;
      b.dataset.path = a.path;
      panel.appendChild(b);
    }
    panel.hidden = false;
  });

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('.wapp');
    if (b && b.dataset.path) window.widget.openApp(b.dataset.path);
  });

  // ── 私聊入口 + 未读提示 ──
  const AGENT_AVATAR = { '赫尔': '🔮', 'ZCode': '⌨️', '蓝鳍': '🐋', '砚舟': '🖋️' };
  const dmPanel = document.createElement('div');
  dmPanel.id = 'wdm';
  dmPanel.hidden = true;
  document.body.appendChild(dmPanel);

  let dmRefreshing = false;
  async function renderDmSheet() {
    if (!dmRefreshing && typeof window.__refreshGroups === 'function') {
      dmRefreshing = true;
      try { await window.__refreshGroups(); } catch {}
      finally { dmRefreshing = false; }
    }
    const idx = (typeof window.__dmIndex === 'function' && window.__dmIndex()) || { dms: [] };
    const dms = idx.dms || [];
    dmPanel.replaceChildren();
    for (const d of dms) {
      const row = document.createElement('div');
      row.className = 'wdm-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const av = document.createElement('span');
      av.className = 'wdm-av';
      av.textContent = AGENT_AVATAR[d.name] || '🤖';
      const nm = document.createElement('span');
      nm.className = 'wdm-nm';
      nm.textContent = d.name;
      const un = document.createElement('span');
      un.className = 'wdm-un';
      un.textContent = String(d.unread || 0);
      un.hidden = !d.unread;
      row.append(av, nm, un);
      row.addEventListener('click', () => {
        dmPanel.hidden = true;
        window.__openDm?.(d.name);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });
      dmPanel.appendChild(row);
    }
    const total = dms.reduce((s, d) => s + (d.unread || 0), 0);
    dmBadge.textContent = total > 99 ? '99+' : String(total);
    dmBadge.hidden = total === 0;
    dmBtn.setAttribute('aria-label', total ? '私聊，' + total + ' 条未读' : '私聊');
    dmBtn.title = total ? '私聊（' + total + ' 条未读）' : '私聊';
  }

  dmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dmPanel.hidden) { dmPanel.hidden = true; return; }
    panel.hidden = true;
    renderDmSheet();
    dmPanel.hidden = false;
  });

  document.addEventListener('click', (e) => {
    if (!dmPanel.hidden && !e.target.closest('#wdm') && !e.target.closest('#wctl-dm')) dmPanel.hidden = true;
    if (!panel.hidden && !e.target.closest('#wapps') && !e.target.closest('#wctl-apps')) panel.hidden = true;
  });

  setInterval(renderDmSheet, 3000);
  renderDmSheet();

  closeBtn.addEventListener('click', () => window.widget.close());

  document.querySelectorAll('.topbar button, .topbar input, .topbar .search-box, .topbar .conn, .topbar a')
    .forEach((el) => { el.style.webkitAppRegion = 'no-drag'; });

  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  for (const dir of dirs) {
    const h = document.createElement('div');
    h.className = 'wrs wrs-' + dir;
    document.body.appendChild(h);
    h.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const start = { x: e.screenX, y: e.screenY };
      const b = await window.widget.getBounds();
      const move = (ev) => {
        let { x, y, width, height } = b;
        const dx = ev.screenX - start.x;
        const dy = ev.screenY - start.y;
        if (dir.includes('e')) width = Math.max(420, b.width + dx);
        if (dir.includes('s')) height = Math.max(420, b.height + dy);
        if (dir.includes('w')) { width = Math.max(420, b.width - dx); x = b.x + (b.width - width); }
        if (dir.includes('n')) { height = Math.max(420, b.height - dy); y = b.y + (b.height - height); }
        window.widget.setBounds({ x, y, width, height });
      };
      const up = (ev) => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        try { h.releasePointerCapture(ev.pointerId); } catch {}
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  }
})();
`;

function createWindow() {
  const saved = PROBE ? null : loadBounds();
  const win = new BrowserWindow({
    width: saved?.width || (PROBE ? 420 : 860),
    height: saved?.height || (PROBE ? 260 : 900),
    x: saved?.x ?? (PROBE ? 1150 : 700),
    y: saved?.y ?? (PROBE ? 120 : 40),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    minWidth: 420,
    minHeight: 420,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(false);

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds())); } catch {}
    }, 300);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);

  win.once('ready-to-show', () => {
    win.showInactive();
    if (!PROBE) startZorderKeeper();
  });

  if (PROBE) {
    win.loadFile(path.join(__dirname, 'probe.html'));
    win.setResizable(false);
  } else {
    win.loadURL('http://127.0.0.1:8787');
    win.webContents.on('did-finish-load', () => {
      writeHwnd(win);
      win.webContents.insertCSS(WIDGET_CSS);
      win.webContents.executeJavaScript(WIDGET_JS).catch(() => {});
    });
  }

  ipcMain.on('widget:close', () => win.close());
  ipcMain.on('widget:open-app', (_e, target) => {
    // 白名单：只放行 scanApps 扫出来的桌面快捷方式，渲染进程被攻破也开不了任意路径
    const allowed = scanApps().some((a) => a.path === target);
    if (allowed && typeof target === 'string' && target.length < 512) shell.openPath(target);
  });
  ipcMain.handle('widget:get-apps', () => scanApps());
  ipcMain.handle('widget:get-bounds', () => win.getBounds());
  ipcMain.on('widget:set-bounds', (_e, b) => {
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      win.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.max(420, Math.round(b.width)),
        height: Math.max(420, Math.round(b.height)),
      });
    }
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
});

app.on('before-quit', () => {
  try { fs.unlinkSync(HWND_FILE); } catch {}
});

app.on('window-all-closed', () => app.quit());
