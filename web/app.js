// 群聊前端 · 零依赖单文件应用
// 目标：实时收发、历史回溯、断线补齐不丢不重、成员与权限管理、异常路径可达

const API = '/api';
const TOKEN_KEY = 'gc_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  groups: [],
  currentGroupId: null,
  group: null,
  members: [],
  messages: new Map(), // groupId -> [{...msg}] 按 seq 升序
  seqIndex: new Map(), // groupId -> Set(seq)
  online: new Set(),
  outbox: new Map(), // clientMsgId -> {groupId, text, type, status, messageId, seq, retry}
  oldestSeq: new Map(),
  hasMore: new Map(),
  readBaseline: new Map(), // groupId -> 进入群时的已读游标（用于未读分割线，本次停留期间固定）
  reportedRead: new Map(), // groupId -> 已向服务端上报到的最大 seq
  agentStatus: new Map(), // groupId -> { userId: { status, reason, at } } 智能体状态牌
  replyTo: null, // { id, name, snippet } 当前正在引用回复的消息
  searchTimer: null,
  ws: null,
  wsState: 'connecting',
  modelCatalog: [],
  reconnectDelay: 1000,
  pingTimer: null,
  pongDeadline: 0,
  manualClose: false,
};
// 调试钩子：控制台可直接查状态（window.__gcState）
if (typeof window !== 'undefined') window.__gcState = state;

// ── DOM ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const authView = $('auth-view');
const appView = $('app-view');

// ── 小工具 ───────────────────────────────────────────
function toast(message, kind = 'info', ms = 3600) {
  const box = document.createElement('div');
  box.className = 'toast';
  box.dataset.kind = kind;
  box.textContent = message;
  $('toasts').appendChild(box);
  setTimeout(() => box.remove(), ms);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return '今天';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}
function dayKey(iso) {
  return new Date(iso).toDateString();
}
function initials(name) {
  const s = String(name || '?').trim();
  return s.slice(0, 1).toUpperCase();
}
function colorFor(id) {
  const palette = ['#4b5563', '#7c3aed', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#065f46', '#7c2d12'];
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return palette[h % palette.length];
}
function uid() {
  return 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function nearBottom(el, slack = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

// ── 简易模态框 ───────────────────────────────────────
function modal({ title, label, value = '', placeholder = '', confirmText = '确定', cancelText = '取消', danger = false, body = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.className = 'modal-title';
    h.textContent = title;
    box.appendChild(h);

    let input = null;
    if (label) {
      const l = document.createElement('label');
      l.className = 'modal-label';
      l.textContent = label;
      l.setAttribute('for', 'modal-input');
      input = document.createElement('input');
      input.id = 'modal-input';
      input.className = 'modal-input';
      input.value = value;
      input.placeholder = placeholder;
      box.appendChild(l);
      box.appendChild(input);
    }
    if (body) box.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = cancelText;
    const ok = document.createElement('button');
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    ok.type = 'button';
    ok.textContent = confirmText;
    actions.append(cancel, ok);
    box.appendChild(actions);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    const close = (val) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && label && document.activeElement === input) close(input.value);
    };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(label ? input.value : true));
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(null);
    });
    document.addEventListener('keydown', onKey);
    (input || ok).focus();
    if (input) input.select();
  });
}

// ── API ──────────────────────────────────────────────
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw !== undefined) opts.body = raw;
  const res = await fetch(API + path, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (res.status === 401 && state.me) {
    doLogout(true);
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    const msg = data?.error?.message || `请求失败（${res.status}）`;
    const err = new Error(msg);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── 鉴权视图 ─────────────────────────────────────────
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').setAttribute('aria-selected', String(mode === 'login'));
  $('tab-register').setAttribute('aria-selected', String(mode === 'register'));
  $('field-displayname').hidden = mode !== 'register';
  $('auth-submit').textContent = mode === 'login' ? '登录' : '注册并进入';
  $('auth-error').textContent = '';
  $('f-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('auth-hint').textContent =
    mode === 'login' ? '登录后即可建群、邀请成员、实时收发消息。' : '设置用户名、昵称与密码，即可开始使用。';
}
$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-register').addEventListener('click', () => setAuthMode('register'));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const username = $('f-username').value.trim();
  const password = $('f-password').value;
  const displayName = $('f-displayname').value.trim();
  const errEl = $('auth-error');
  errEl.textContent = '';
  if (!username) return (errEl.textContent = '请输入用户名');
  if (!password) return (errEl.textContent = '请输入密码');
  form.setAttribute('aria-busy', 'true');
  $('auth-submit').disabled = true;
  try {
    const path = authMode === 'login' ? '/auth/login' : '/auth/register';
    const payload = authMode === 'login' ? { username, password } : { username, password, displayName };
    const data = await api(path, { method: 'POST', body: payload });
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    enterApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    form.removeAttribute('aria-busy');
    $('auth-submit').disabled = false;
  }
});

function doLogout(silent = false) {
  state.manualClose = true;
  try {
    state.ws?.close();
  } catch {}
  state.token = '';
  state.me = null;
  localStorage.removeItem(TOKEN_KEY);
  closeSocketTimers();
  authView.hidden = false;
  appView.hidden = true;
  if (!silent) api('/auth/logout', { method: 'POST' }).catch(() => {});
  setAuthMode('login');
}
$('btn-logout').addEventListener('click', () => doLogout(false));

// ── 进入应用 ─────────────────────────────────────────
async function enterApp() {
  authView.hidden = true;
  appView.hidden = false;
  renderMe();
  connectSocket();
  await refreshGroups();
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code) {
    history.replaceState(null, '', '/');
    await joinByCode(code, true);
  }
}

function renderMe() {
  const box = $('me-box');
  box.innerHTML = '';
  const n = document.createElement('div');
  n.className = 'me-name';
  n.textContent = state.me?.displayName || '';
  const s = document.createElement('div');
  s.className = 'me-sub';
  s.textContent = '@' + (state.me?.username || '');
  box.append(n, s);
}

// ── 群列表 ───────────────────────────────────────────
async function refreshGroups() {
  try {
    const data = await api('/groups');
    state.groups = data.groups || [];
    renderGroups();
    if (state.currentGroupId && !state.groups.find((g) => g.id === state.currentGroupId)) {
      state.currentGroupId = null;
      state.group = null;
      renderHeader();
      renderMessages();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderGroups() {
  const list = $('group-list');
  list.innerHTML = '';
  $('group-count').textContent = state.groups.length ? `(${state.groups.length})` : '';
  $('group-empty').hidden = state.groups.length > 0;
  for (const g of state.groups) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'group-item';
    btn.type = 'button';
    btn.setAttribute('aria-current', String(g.id === state.currentGroupId));
    const top = document.createElement('div');
    top.className = 'group-item-top';
    const name = document.createElement('span');
    name.className = 'group-item-name';
    name.textContent = (g.avatar ? g.avatar + ' ' : '') + g.name;
    top.appendChild(name);
    if (g.unread > 0 && g.id !== state.currentGroupId) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = g.unread > 99 ? '99+' : String(g.unread);
      b.title = `${g.unread} 条未读`;
      top.appendChild(b);
    }
    const bottom = document.createElement('div');
    bottom.className = 'group-item-bottom';
    const role = document.createElement('span');
    role.textContent = g.role === 'owner' ? '群主' : '成员';
    const mc = document.createElement('span');
    mc.textContent = `${g.memberCount} 人`;
    bottom.append(role, document.createTextNode('·'), mc);
    btn.append(top, bottom);
    btn.addEventListener('click', () => selectGroup(g.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

// ── 选择群 ───────────────────────────────────────────
async function selectGroup(groupId) {
  if (state.currentGroupId === groupId) {
    closeSidebarOnMobile();
    return;
  }
  state.currentGroupId = groupId;
  cancelReply();
  renderGroups();
  // 清空消息区（旧内容与静态空态节点一并移除，空态由 renderMessages 重建）
  $('messages').innerHTML = '';
  try {
    await loadGroupDetail(groupId);
    await loadMessages(groupId);
    subscribe(groupId);
  } catch (err) {
    toast(err.message, 'error');
  }
  closeSidebarOnMobile();
  renderGroups();
}

async function loadGroupDetail(groupId) {
  const data = await api(`/groups/${groupId}`);
  state.group = data.group;
  state.members = data.members || [];
  state.agentStatus.set(groupId, data.agentStatus || {});
  if (!state.readBaseline.has(groupId)) {
    const me = state.members.find((m) => state.me && m.id === state.me.id);
    state.readBaseline.set(groupId, me ? Number(me.lastReadSeq || 0) : 0);
  }
  if (!state.modelCatalog.length) await ensureModelCatalog();
  renderHeader();
  renderMembers();
}

// 把当前群里已看到的最大 seq 上报给服务端（游标只前进不后退）
function reportRead(groupId) {
  if (!groupId || groupId !== state.currentGroupId || !state.ws) return;
  const msgs = state.messages.get(groupId) || [];
  const maxSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
  const sent = state.reportedRead.get(groupId) || 0;
  if (!maxSeq || maxSeq <= sent) return;
  state.reportedRead.set(groupId, maxSeq);
  state.ws.send(JSON.stringify({ type: 'read', groupId, seq: maxSeq }));
  const me = state.members.find((m) => state.me && m.id === state.me.id);
  if (me) me.lastReadSeq = Math.max(Number(me.lastReadSeq || 0), maxSeq);
}

// 模型下拉可选项（全局拉一次并缓存）
async function ensureModelCatalog() {
  if (state.modelCatalog.length) return;
  try {
    const data = await api('/models');
    state.modelCatalog = (data.models || []).map((m) => m.id);
  } catch {
    state.modelCatalog = [];
  }
}

// 为某个 Agent 设置所用大模型
async function setAgentModel(agentKey, model, displayName) {
  try {
    await api(`/groups/${state.currentGroupId}/agents/${agentKey}`, { method: 'PATCH', body: { model } });
    toast(`${displayName} 的模型已设为「${model || '默认模型'}」`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    await loadGroupDetail(state.currentGroupId);
  }
}

// 「已读 x/n」：除自己外的成员里，读到最新一条的有几个人
function readSummary(g) {
  const msgs = state.messages.get(g.id) || [];
  const latest = Math.max(Number(g.latestSeq || 0), msgs.length ? msgs[msgs.length - 1].seq : 0);
  const peers = state.members.filter((m) => !state.me || m.id !== state.me.id);
  if (!peers.length) return '已读 0/0';
  const done = latest ? peers.filter((m) => Number(m.lastReadSeq || 0) >= latest).length : 0;
  return `已读 ${done}/${peers.length}`;
}

function renderHeader() {
  const g = state.group;
  $('group-title').textContent = g ? (g.avatar ? g.avatar + ' ' : '') + g.name : '选择一个群';
  const meta = $('group-meta');
  meta.textContent = g ? `${state.members.length} 位成员 · ${g.role === 'owner' ? '你是群主' : '你是成员'} · ${readSummary(g)}` : '';
  $('composer-input').disabled = !g;
  $('btn-send').disabled = !g;
  const searchInput = $('search-input');
  if (searchInput) {
    searchInput.disabled = !g;
    if (!g) {
      searchInput.value = '';
      $('search-results').hidden = true;
    }
  }
  if (g && g.role === 'owner') $('composer-note').textContent = '你是群主，可在右侧成员面板管理成员或解散群聊。';
  else if (g) $('composer-note').textContent = '';
  else $('composer-note').textContent = '';
}

// ── 消息加载与渲染 ───────────────────────────────────
async function loadMessages(groupId) {
  const data = await api(`/groups/${groupId}/messages?limit=30`);
  state.messages.set(groupId, data.messages || []);
  state.seqIndex.set(groupId, new Set((data.messages || []).map((m) => m.seq)));
  state.oldestSeq.set(groupId, data.messages?.length ? data.messages[0].seq : null);
  state.hasMore.set(groupId, !!data.hasMore);
  renderMessages();
  scrollToBottom();
  renderHeader();
  reportRead(groupId);
}

async function loadOlder() {
  const groupId = state.currentGroupId;
  if (!groupId) return;
  const oldest = state.oldestSeq.get(groupId);
  if (!oldest) return;
  const btn = $('btn-load-older');
  btn.disabled = true;
  try {
    const data = await api(`/groups/${groupId}/messages?beforeSeq=${oldest}&limit=30`);
    const current = state.messages.get(groupId) || [];
    const merged = [...(data.messages || []), ...current];
    state.messages.set(groupId, merged);
    (data.messages || []).forEach((m) => state.seqIndex.get(groupId)?.add(m.seq));
    state.oldestSeq.set(groupId, data.messages?.length ? data.messages[0].seq : oldest);
    state.hasMore.set(groupId, !!data.hasMore);
    renderMessages({ keepScroll: true, prevHeight: $('messages').scrollHeight });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('btn-load-older').addEventListener('click', loadOlder);

function addMessageToState(groupId, msg) {
  const arr = state.messages.get(groupId) || [];
  const idx = state.seqIndex.get(groupId) || new Set();
  if (msg.seq && idx.has(msg.seq)) return false; // 去重：断线补齐可能与实时推送重叠
  if (msg.seq) idx.add(msg.seq);
  arr.push(msg);
  arr.sort((a, b) => a.seq - b.seq);
  state.messages.set(groupId, arr);
  state.seqIndex.set(groupId, idx);
  return true;
}

function renderMessages({ keepScroll = false, prevHeight = 0 } = {}) {
  const groupId = state.currentGroupId;
  const box = $('messages');
  if (!groupId) {
    box.innerHTML = '';
    const e = document.createElement('p');
    e.className = 'empty-state';
    e.textContent = '从左侧选择或新建一个群聊。';
    box.appendChild(e);
    return;
  }
  const msgs = state.messages.get(groupId) || [];
  const stick = nearBottom(box);
  box.innerHTML = '';

  if (!msgs.length) {
    const e = document.createElement('p');
    e.className = 'empty-state';
    e.textContent = '这里还没有消息，说点什么吧。';
    box.appendChild(e);
  }

  let lastDay = null;
  let prev = null;
  const anchor = state.readBaseline.get(groupId) || 0;
  const firstUnread = anchor > 0 ? msgs.findIndex((m) => m.seq > anchor) : -1;
  for (const [i, m] of msgs.entries()) {
    if (i === firstUnread && i > 0) {
      const sep = document.createElement('div');
      sep.className = 'unread-sep';
      sep.textContent = '以下是未读';
      box.appendChild(sep);
    }
    const dk = dayKey(m.createdAt);
    if (dk !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = fmtDay(m.createdAt);
      box.appendChild(sep);
      lastDay = dk;
      prev = null;
    }
    box.appendChild(buildMessage(m, prev));
    prev = m;
  }

  $('loadmore').hidden = !state.hasMore.get(groupId);
  if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight;
  else if (stick) scrollToBottom();
}

function buildMessage(m, prev) {
  const continues =
    prev &&
    prev.senderId === m.senderId &&
    prev.type === m.type &&
    new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60 * 1000;
  const row = document.createElement('article');
  row.className = 'msg' + (continues ? ' continues' : '');
  row.dataset.seq = String(m.seq);
  row.dataset.id = m.id;

  const av = document.createElement('div');
  av.className = 'msg-avatar' + (m.senderKind === 'agent' ? ' agent' : '');
  av.style.background = m.senderKind === 'agent' ? '#16181a' : colorFor(m.senderId);
  av.textContent = m.senderAvatar && m.senderKind === 'agent'
    ? m.senderAvatar
    : initials(m.senderName || m.senderUsername);
  av.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('span');
  who.className = 'msg-sender';
  const isMe = m.senderId === state.me?.id;
  const isAgent = m.senderKind === 'agent';
  who.textContent = (m.senderName || m.senderUsername || '未知') + (isMe ? '（我）' : '');
  head.appendChild(who);
  if (isAgent) {
    const badge = document.createElement('span');
    badge.className = 'bot-badge';
    badge.textContent = 'BOT';
    badge.title = '这是一个智能体（Agent）账号';
    head.appendChild(badge);
  }
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = fmtTime(m.createdAt);
  time.title = new Date(m.createdAt).toLocaleString('zh-CN');
  head.appendChild(time);
  if (!m.status) {
    const acts = document.createElement('span');
    acts.className = 'msg-actions';
    const rep = document.createElement('button');
    rep.className = 'btn-link';
    rep.type = 'button';
    rep.textContent = '回复';
    rep.title = '引用这条消息回复';
    rep.addEventListener('click', () => startReply(m));
    acts.appendChild(rep);
    head.appendChild(acts);
  }
  if (m.status) {
    const st = document.createElement('span');
    st.className = 'msg-status';
    st.dataset.status = m.status;
    st.textContent = m.status === 'sending' ? '发送中…' : m.status === 'failed' ? '发送失败' : '已发送';
    head.appendChild(st);
    if (m.status === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'btn-link msg-retry';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => retryMessage(m.clientMsgId));
      head.appendChild(retry);
    }
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (m.replyTo) {
    const q = document.createElement('div');
    q.className = 'quote-block';
    q.title = '点击跳到被引用的消息';
    const rp = m.replyPreview || null;
    const sender = document.createElement('span');
    sender.className = 'quote-sender';
    sender.textContent = rp && !rp.missing && !rp.deleted ? rp.senderName : '原消息';
    const qb = document.createElement('span');
    qb.className = 'quote-body';
    qb.textContent = !rp || rp.missing
      ? '（未加载，点击尝试定位）'
      : rp.deleted
        ? '原消息已删除'
        : rp.body || '[图片]';
    q.append(sender, qb);
    q.addEventListener('click', () => jumpToMessage(m.replyTo, Number(rp?.seq) || 0));
    body.appendChild(q);
  }
  if (m.type === 'image' && m.attachmentId) {
    const img = document.createElement('img');
    img.src = `/api/attachments/${m.attachmentId}`;
    img.alt = m.body ? `图片：${m.body}` : '图片消息';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      const warn = document.createElement('span');
      warn.className = 'muted small';
      warn.textContent = '[图片加载失败，可尝试刷新]';
      img.replaceWith(warn);
    });
    body.appendChild(img);
    if (m.body) {
      const cap = document.createElement('div');
      cap.textContent = m.body;
      body.appendChild(cap);
    }
  } else {
    // 注意：textContent 赋值会清空子节点，必须用独立文本节点，不能直接赋给 body（否则引用块被抹掉）
    const text = document.createElement('div');
    text.textContent = m.body;
    body.appendChild(text);
  }

  main.append(head, body);
  row.append(av, main);
  return row;
}

function renderOptimistic(entry) {
  const box = $('messages');
  const m = {
    id: entry.clientMsgId,
    clientMsgId: entry.clientMsgId,
    groupId: entry.groupId,
    seq: Number.MAX_SAFE_INTEGER,
    senderId: state.me.id,
    senderName: state.me.displayName,
    senderUsername: state.me.username,
    type: entry.type || 'text',
    body: entry.text,
    attachmentId: entry.attachmentId || null,
    replyTo: entry.replyTo || null,
    replyPreview: entry.replyPreview || null,
    createdAt: new Date().toISOString(),
    status: 'sending',
  };
  const stick = nearBottom(box);
  box.appendChild(buildMessage(m, null));
  if (stick) scrollToBottom();
}

function updateOptimistic(clientMsgId, status) {
  const row = $('messages').querySelector(`[data-id="${clientMsgId}"]`);
  const entry = state.outbox.get(clientMsgId);
  if (!row) return;
  let st = row.querySelector('.msg-status');
  if (!st) {
    st = document.createElement('span');
    st.className = 'msg-status';
    row.querySelector('.msg-head')?.appendChild(st);
  }
  st.dataset.status = status;
  st.textContent = status === 'sending' ? '发送中…' : status === 'failed' ? '发送失败' : '已发送';
  row.querySelector('.msg-retry')?.remove();
  if (status === 'failed') {
    const retry = document.createElement('button');
    retry.className = 'btn-link msg-retry';
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => retryMessage(clientMsgId));
    row.querySelector('.msg-head')?.appendChild(retry);
    if (entry) entry.status = 'failed';
  }
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// 「正在输入…」提示（人类与 Agent 共用）
function renderTyping() {
  const el = $('composer-note');
  if (!el) return;
  const now = Date.now();
  const names = [];
  for (const [uid, t] of state.typing || []) {
    if (now - t.at > 6000) {
      state.typing.delete(uid);
      continue;
    }
    names.push(t.name + (t.kind === 'agent' ? '（智能体）' : ''));
  }
  el.textContent = names.length ? `${names.join('、')} 正在输入…` : '';
  if (state.typing && state.typing.size) {
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(renderTyping, 1500);
  }
}

$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  if (box.scrollTop < 60 && state.hasMore.get(state.currentGroupId)) loadOlder();
});

// ── 引用回复 ─────────────────────────────────────────
function startReply(m) {
  if (!state.currentGroupId) return;
  state.replyTo = {
    id: m.id,
    name: m.senderName || m.senderUsername || '未知',
    snippet: m.type === 'image' ? '[图片]' : String(m.body || '').slice(0, 60),
  };
  renderReplyChip();
  $('composer-input').focus();
}

function cancelReply() {
  state.replyTo = null;
  renderReplyChip();
}

function renderReplyChip() {
  const chip = $('reply-chip');
  if (!chip) return;
  chip.innerHTML = '';
  chip.hidden = !state.replyTo;
  if (!state.replyTo) return;
  const t = document.createElement('span');
  t.className = 'reply-text';
  const b = document.createElement('b');
  b.textContent = '回复 ' + state.replyTo.name + '：';
  t.appendChild(b);
  t.appendChild(document.createTextNode(state.replyTo.snippet));
  const x = document.createElement('button');
  x.className = 'btn btn-ghost icon-btn';
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', '取消引用');
  x.addEventListener('click', cancelReply);
  chip.append(t, x);
}

// ── 历史搜索 ─────────────────────────────────────────
const searchInput = $('search-input');
const searchResults = $('search-results');

searchInput.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  const gid = state.currentGroupId;
  const q = searchInput.value.trim();
  if (!gid || !q) {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    return;
  }
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/groups/${gid}/search?q=${encodeURIComponent(q)}&limit=20`);
      renderSearchResults(gid, q, data.messages || []);
    } catch {
      searchResults.hidden = true;
    }
  }, 300);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) searchResults.hidden = true;
});

function renderSearchResults(gid, q, rows) {
  searchResults.innerHTML = '';
  if (gid !== state.currentGroupId) return;
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'search-empty';
    e.textContent = `没有找到包含「${q}」的消息`;
    searchResults.appendChild(e);
  }
  for (const r of rows) {
    const item = document.createElement('button');
    item.className = 'search-item';
    item.type = 'button';
    const top = document.createElement('div');
    top.className = 'search-item-top';
    const s = document.createElement('span');
    s.className = 'search-item-sender';
    s.textContent = (r.senderKind === 'agent' ? '🤖 ' : '') + (r.senderName || r.senderUsername || '未知');
    const t = document.createElement('span');
    t.textContent = new Date(r.createdAt).toLocaleString('zh-CN');
    top.append(s, t);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'search-item-body';
    const idx = r.body.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) {
      bodyEl.append(
        document.createTextNode(r.body.slice(0, idx)),
        Object.assign(document.createElement('mark'), { textContent: r.body.slice(idx, idx + q.length) }),
        document.createTextNode(r.body.slice(idx + q.length)),
      );
    } else {
      bodyEl.textContent = r.body;
    }
    item.append(top, bodyEl);
    item.addEventListener('click', () => {
      searchResults.hidden = true;
      searchInput.value = '';
      jumpToSeq(gid, Number(r.seq), r.id);
    });
    searchResults.appendChild(item);
  }
  searchResults.hidden = false;
}

// 跳转到某条消息：不在已加载窗口内就先拉附近一屏
async function jumpToSeq(gid, seq, id) {
  if (gid !== state.currentGroupId) return;
  if (!(state.seqIndex.get(gid) || new Set()).has(seq)) {
    try {
      const data = await api(`/groups/${gid}/messages?aroundSeq=${seq}&limit=30`);
      const merged = [...(state.messages.get(gid) || []), ...(data.messages || [])];
      merged.sort((a, b) => a.seq - b.seq);
      const seen = new Set();
      const dedup = merged.filter((m) => (seen.has(m.seq) ? false : (seen.add(m.seq), true)));
      state.messages.set(gid, dedup);
      state.seqIndex.set(gid, new Set(dedup.map((m) => m.seq)));
      state.oldestSeq.set(gid, dedup.length ? dedup[0].seq : null);
      state.hasMore.set(gid, true);
      renderMessages();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  jumpToMessage(id);
}

function jumpToMessage(id) {
  const row = $('messages').querySelector(`[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('highlight');
  setTimeout(() => row.classList.remove('highlight'), 1600);
}

// ── 发送 ─────────────────────────────────────────────
async function sendMessage(text) {
  const groupId = state.currentGroupId;
  if (!groupId) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.length > 2000) {
    toast('消息长度不能超过 2000 字', 'error');
    return;
  }
  const clientMsgId = uid();
  const replyInfo = state.replyTo;
  const entry = {
    clientMsgId,
    groupId,
    text: trimmed,
    type: 'text',
    status: 'sending',
    replyTo: replyInfo?.id || null,
    replyPreview: replyInfo
      ? { id: replyInfo.id, senderName: replyInfo.name, body: replyInfo.snippet }
      : null,
  };
  state.outbox.set(clientMsgId, entry);
  cancelReply();
  renderOptimistic(entry);
  dispatchOutbox(clientMsgId);
}

function dispatchOutbox(clientMsgId) {
  const entry = state.outbox.get(clientMsgId);
  if (!entry) return;
  entry.status = 'sending';
  updateOptimistic(clientMsgId, 'sending');
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(
      JSON.stringify({
        type: entry.attachmentId ? 'send-image' : 'send',
        groupId: entry.groupId,
        clientMsgId,
        text: entry.text,
        caption: entry.text,
        attachmentId: entry.attachmentId,
        replyTo: entry.replyTo || null,
      }),
    );
    entry.timer = setTimeout(() => {
      if (state.outbox.get(clientMsgId)?.status === 'sending') {
        updateOptimistic(clientMsgId, 'failed');
        toast('发送超时，可点击「重试」', 'error');
      }
    }, 8000);
  } else {
    // 实时通道未就绪 → 走 REST 兜底（服务端按 clientMsgId 幂等）
    api(`/groups/${entry.groupId}/messages`, {
      method: 'POST',
      body: { text: entry.text, clientMsgId, replyTo: entry.replyTo || null },
    })
      .then((data) => {
        onAck({ clientMsgId, messageId: data.message.id, seq: data.message.seq, createdAt: data.message.createdAt });
      })
      .catch((err) => {
        updateOptimistic(clientMsgId, 'failed');
        toast(err.message, 'error');
      });
  }
}

function retryMessage(clientMsgId) {
  const entry = state.outbox.get(clientMsgId);
  if (!entry) return;
  clearTimeout(entry.timer);
  dispatchOutbox(clientMsgId);
}

function onAck({ clientMsgId, messageId, seq, createdAt }) {
  const entry = state.outbox.get(clientMsgId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.status = 'sent';
  // 1) 先按旧的 data-id 把状态改成「已发送」（此刻行仍挂着 clientMsgId）
  updateOptimistic(clientMsgId, 'sent');
  // 2) 再把该行改名为服务端消息 id，并记录序号
  const row = $('messages').querySelector(`[data-id="${clientMsgId}"]`);
  if (row) {
    row.dataset.id = messageId;
    row.dataset.seq = String(seq);
  }
  const arr = state.messages.get(entry.groupId) || [];
  const exists = (state.seqIndex.get(entry.groupId) || new Set()).has(seq);
  if (!exists) {
    arr.push({
      id: messageId,
      groupId: entry.groupId,
      seq,
      senderId: state.me.id,
      senderName: state.me.displayName,
      senderUsername: state.me.username,
      type: entry.type || 'text',
      body: entry.text,
      attachmentId: entry.attachmentId || null,
      replyTo: entry.replyTo || null,
      replyPreview: entry.replyPreview || null,
      createdAt,
    });
    arr.sort((a, b) => a.seq - b.seq);
    state.messages.set(entry.groupId, arr);
    state.seqIndex.get(entry.groupId)?.add(seq);
  }
  state.outbox.delete(clientMsgId);
  refreshGroups();
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('composer-input');
  const text = input.value;
  input.value = '';
  autoResize(input);
  sendMessage(text);
});

const inputEl = $('composer-input');
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(160, el.scrollHeight) + 'px';
}
inputEl.addEventListener('input', () => {
  autoResize(inputEl);
  // 通知对端「正在输入」（节流 3 秒）
  const now = Date.now();
  if (state.currentGroupId && state.ws && state.ws.readyState === WebSocket.OPEN && now - (state.lastTypingSent || 0) > 3000) {
    state.lastTypingSent = now;
    state.ws.send(JSON.stringify({ type: 'typing', groupId: state.currentGroupId }));
  }
});

// 图片上传
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    toast('仅支持 PNG / JPEG / WebP / GIF 图片', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('图片不能超过 5MB', 'error');
    return;
  }
  if (!state.currentGroupId) {
    toast('请先选择一个群', 'error');
    return;
  }
  const note = $('composer-note');
  note.textContent = '图片上传中…';
  try {
    const data = await api('/uploads', {
      method: 'POST',
      raw: file,
      headers: { 'content-type': file.type, 'x-filename': file.name },
    });
    note.textContent = '';
    const clientMsgId = uid();
    const entry = {
      clientMsgId,
      groupId: state.currentGroupId,
      text: '',
      type: 'image',
      attachmentId: data.attachment.id,
      replyTo: state.replyTo?.id || null,
      replyPreview: state.replyTo
        ? { id: state.replyTo.id, senderName: state.replyTo.name, body: state.replyTo.snippet }
        : null,
      status: 'sending',
    };
    state.outbox.set(clientMsgId, entry);
    cancelReply();
    renderOptimistic(entry);
    dispatchOutbox(clientMsgId);
  } catch (err) {
    note.textContent = '';
    toast(err.message, 'error');
  }
});

// ── 成员面板 ─────────────────────────────────────────
function renderMembers() {
  const list = $('member-list');
  list.innerHTML = '';
  const actions = $('members-actions');
  actions.innerHTML = '';
  const g = state.group;
  if (!g) return;

  const invite = document.createElement('button');
  invite.className = 'btn btn-block';
  invite.type = 'button';
  invite.textContent = '复制邀请链接';
  invite.addEventListener('click', async () => {
    try {
      const data = await api(`/groups/${g.id}/invite`, { method: 'POST' });
      const url = `${location.origin}/join?code=${data.inviteCode}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('邀请链接已复制：' + url, 'success', 5000);
      } catch {
        toast('邀请链接：' + url, 'info', 8000);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  actions.appendChild(invite);

  if (g.role === 'owner') {
    const rename = document.createElement('button');
    rename.className = 'btn btn-block';
    rename.type = 'button';
    rename.textContent = '修改群名 / 头像';
    rename.addEventListener('click', async () => {
      const name = await modal({
        title: '修改群信息',
        label: '群名称',
        value: g.name,
        confirmText: '保存',
      });
      if (name === null) return;
      const avatar = await modal({
        title: '修改群信息',
        label: '群头像（单个 emoji 或短字符，可留空）',
        value: g.avatar || '',
      });
      if (avatar === null) return;
      try {
        await api(`/groups/${g.id}`, { method: 'PATCH', body: { name, avatar } });
        await loadGroupDetail(g.id);
        await refreshGroups();
        toast('群信息已更新', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    actions.appendChild(rename);

    const dissolve = document.createElement('button');
    dissolve.className = 'btn btn-danger btn-block';
    dissolve.type = 'button';
    dissolve.textContent = '解散群聊';
    dissolve.addEventListener('click', async () => {
      const ok = await modal({
        title: '解散群聊',
        label: `输入群名「${g.name}」以确认解散`,
        placeholder: g.name,
        confirmText: '确认解散',
        danger: true,
      });
      if (ok !== g.name) {
        if (ok !== null) toast('群名不匹配，已取消', 'error');
        return;
      }
      try {
        await api(`/groups/${g.id}`, { method: 'DELETE' });
        toast('群聊已解散', 'success');
        state.currentGroupId = null;
        state.group = null;
        state.messages.delete(g.id);
        renderHeader();
        renderMessages();
        await refreshGroups();
        toggleMembers(false);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    actions.appendChild(dissolve);
  } else {
    const leave = document.createElement('button');
    leave.className = 'btn btn-danger btn-block';
    leave.type = 'button';
    leave.textContent = '退出群聊';
    leave.addEventListener('click', async () => {
      const ok = await modal({
        title: '退出群聊',
        label: `确认退出「${g.name}」？退出后将无法查看该群消息。`,
        confirmText: '退出',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/groups/${g.id}/leave`, { method: 'POST' });
        toast('已退出群聊', 'success');
        state.currentGroupId = null;
        state.group = null;
        renderHeader();
        renderMessages();
        await refreshGroups();
        toggleMembers(false);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    actions.appendChild(leave);
  }

  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member-item';
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    dot.dataset.online = String(state.online.has(m.id));
    dot.title = state.online.has(m.id) ? '在线' : '离线';
    const nm = document.createElement('span');
    nm.className = 'member-name';
    nm.textContent = (m.avatar && m.kind === 'agent' ? m.avatar + ' ' : '') + m.displayName + (m.id === state.me.id ? '（我）' : '');
    const role = document.createElement('span');
    role.className = 'member-role' + (m.kind === 'agent' ? ' agent' : '');
    role.textContent = m.kind === 'agent' ? '智能体' : m.role === 'owner' ? '群主' : '成员';
    li.append(dot, nm, role);

    // ── Agent 专属：运行状态牌 + 大模型选择下拉栏 ──
    if (m.kind === 'agent') {
      const st = (state.agentStatus.get(g.id) || {})[m.id];
      if (st && st.status === 'unavailable') {
        const sb = document.createElement('span');
        sb.className = 'member-status';
        sb.dataset.status = 'unavailable';
        sb.textContent = '⚠ 缺席' + (st.reason ? '：' + st.reason : '');
        sb.title = st.reason || '大脑不可用，被点名时会给出无法应答说明';
        li.appendChild(sb);
      }
      if (m.supportsModel === false) {
        const na = document.createElement('span');
        na.className = 'member-model na';
        na.textContent = '模型：不适用（内置大脑）';
        li.appendChild(na);
      } else {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'member-model';
        const lab = document.createElement('label');
        lab.className = 'member-model-label';
        lab.textContent = '模型';
        const sel = document.createElement('select');
        sel.className = 'model-select';
        sel.id = `model-${m.agentKey}`;
        sel.title = `为 ${m.displayName} 选择大模型`;
        sel.setAttribute('aria-label', `为 ${m.displayName} 选择大模型`);
        lab.setAttribute('for', sel.id);

        const cur = m.model || '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '默认模型';
        sel.appendChild(blank);

        const ids = state.modelCatalog.length ? state.modelCatalog : cur ? [cur] : [];
        for (const mid of ids) {
          const o = document.createElement('option');
          o.value = mid;
          o.textContent = mid;
          sel.appendChild(o);
        }
        if (cur && !ids.includes(cur)) {
          const o = document.createElement('option');
          o.value = cur;
          o.textContent = cur + '（当前）';
          sel.appendChild(o);
        }
        sel.value = cur;
        sel.disabled = g.role !== 'owner';
        if (sel.disabled) sel.title = '仅群主可修改智能体的模型';
        sel.addEventListener('change', () => setAgentModel(m.agentKey, sel.value, m.displayName));
        wrapEl.append(lab, sel);
        li.appendChild(wrapEl);
      }
    }

    if (g.role === 'owner' && m.role !== 'owner') {
      const rm = document.createElement('button');
      rm.className = 'btn btn-ghost icon-btn';
      rm.type = 'button';
      rm.textContent = '移除';
      rm.title = `将 ${m.displayName} 移出群聊`;
      rm.addEventListener('click', async () => {
        const ok = await modal({
          title: '移除成员',
          label: `确认将「${m.displayName}」移出群聊？`,
          confirmText: '移除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/groups/${g.id}/members/${m.id}`, { method: 'DELETE' });
          toast('已移除成员', 'success');
          await loadGroupDetail(g.id);
          await refreshGroups();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      li.appendChild(rm);
    }
    list.appendChild(li);
  }
}

function toggleMembers(show) {
  const panel = $('members-panel');
  const shouldShow = show === undefined ? panel.hidden : show;
  panel.hidden = !shouldShow;
  $('layout')?.classList.toggle('with-members', shouldShow);
  document.querySelector('.layout')?.classList.toggle('with-members', shouldShow);
  $('btn-toggle-members').setAttribute('aria-expanded', String(shouldShow));
}
$('btn-toggle-members').addEventListener('click', () => toggleMembers($('members-panel').hidden));
$('btn-close-members').addEventListener('click', () => toggleMembers(false));

// ── 侧栏开关（移动端）────────────────────────────────
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-backdrop').classList.add('show');
  $('sidebar-backdrop').hidden = false;
  $('btn-toggle-sidebar').setAttribute('aria-expanded', 'true');
}
function closeSidebarOnMobile() {
  if (window.matchMedia('(max-width: 860px)').matches) {
    $('sidebar').classList.remove('open');
    $('sidebar-backdrop').classList.remove('show');
    $('sidebar-backdrop').hidden = true;
    $('btn-toggle-sidebar').setAttribute('aria-expanded', 'false');
  }
}
$('btn-toggle-sidebar').addEventListener('click', () => {
  if ($('sidebar').classList.contains('open')) closeSidebarOnMobile();
  else openSidebar();
});
$('sidebar-backdrop').addEventListener('click', closeSidebarOnMobile);

// ── 建群 / 加群 ──────────────────────────────────────
$('btn-create-group').addEventListener('click', async () => {
  const name = await modal({ title: '新建群聊', label: '群名称', placeholder: '例如：产品讨论组', confirmText: '创建' });
  if (!name || !name.trim()) return;
  try {
    const data = await api('/groups', { method: 'POST', body: { name: name.trim() } });
    toast('群聊已创建', 'success');
    await refreshGroups();
    await selectGroup(data.group.id);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('btn-join-group').addEventListener('click', async () => {
  const code = await modal({ title: '加入群聊', label: '邀请码', placeholder: '粘贴邀请码', confirmText: '加入' });
  if (!code) return;
  await joinByCode(code.trim(), false);
});

async function joinByCode(code, fromUrl) {
  try {
    const data = await api('/groups/join', { method: 'POST', body: { inviteCode: code } });
    toast(data.alreadyMember ? '你已在该群中' : '已加入群聊', 'success');
    await refreshGroups();
    await selectGroup(data.group.id);
  } catch (err) {
    toast(err.message, 'error');
    if (fromUrl) {
      const manual = await modal({
        title: '加入群聊',
        label: '邀请码无效，可手动输入',
        placeholder: '邀请码',
        confirmText: '加入',
      });
      if (manual) await joinByCode(manual.trim(), false);
    }
  }
}

// ── 实时通道 ─────────────────────────────────────────
function setConnState(s) {
  state.wsState = s;
  const el = $('conn-state');
  el.dataset.state = s;
  el.querySelector('.conn-text').textContent = s === 'online' ? '已连接' : s === 'connecting' ? '连接中' : '已断开';
}

function connectSocket() {
  state.manualClose = false;
  setConnState('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setConnState('online');
    state.pongDeadline = Date.now() + 45000;
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (Date.now() > state.pongDeadline) {
        toast('连接无响应，正在重连…', 'info');
        try {
          ws.close();
        } catch {}
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
    if (state.currentGroupId) subscribe(state.currentGroupId);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerEvent(msg);
  });

  ws.addEventListener('close', () => {
    clearInterval(state.pingTimer);
    if (!state.manualClose) {
      setConnState('offline');
      scheduleReconnect();
    }
  });
  ws.addEventListener('error', () => {});
}

function scheduleReconnect() {
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(15000, state.reconnectDelay * 2);
  setTimeout(() => {
    if (!state.manualClose && state.token) connectSocket();
  }, delay);
}

function closeSocketTimers() {
  clearInterval(state.pingTimer);
}

function subscribe(groupId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const known = state.messages.get(groupId) || [];
  const sinceSeq = known.length ? known[known.length - 1].seq : 0;
  state.ws.send(JSON.stringify({ type: 'subscribe', groupId, sinceSeq }));
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'ready': {
      if (!msg.user) return;
      break;
    }
    case 'message': {
      const gid = msg.groupId;
      const added = addMessageToState(gid, msg.message);
      if (gid === state.currentGroupId && added) {
        renderMessages();
        renderHeader();
        reportRead(gid);
      }
      if (gid !== state.currentGroupId) {
        const g = state.groups.find((x) => x.id === gid);
        if (g) {
          g.unread = (g.unread || 0) + 1;
          g.latestSeq = Math.max(g.latestSeq || 0, msg.message.seq);
          renderGroups();
        } else {
          refreshGroups();
        }
      }
      break;
    }
    case 'subscribed': {
      state.online = new Set(msg.online || []);
      if (msg.agentStatus) state.agentStatus.set(msg.groupId || state.currentGroupId, msg.agentStatus);
      if (msg.truncated) toast('离线期间消息较多，仅补齐最近 500 条', 'info', 5000);
      if (msg.replayed > 0) toast(`已补齐离线期间的 ${msg.replayed} 条消息`, 'success');
      renderMembers();
      break;
    }
    case 'read-receipt': {
      if (msg.groupId !== state.currentGroupId) break;
      const m = state.members.find((x) => x.id === msg.userId);
      if (m) {
        m.lastReadSeq = Math.max(Number(m.lastReadSeq || 0), Number(msg.seq) || 0);
        renderHeader();
        renderMembers();
      }
      break;
    }
    case 'presence': {
      if (msg.groupId === state.currentGroupId) {
        state.online = new Set(msg.online || []);
        if (msg.agentStatus) state.agentStatus.set(msg.groupId, msg.agentStatus);
        renderMembers();
      }
      break;
    }
    case 'ack': {
      onAck(msg);
      break;
    }
    case 'send_failed': {
      updateOptimistic(msg.clientMsgId, 'failed');
      toast(msg.message || '发送失败，请重试', 'error');
      break;
    }
    case 'error': {
      if (msg.clientMsgId) updateOptimistic(msg.clientMsgId, 'failed');
      toast(msg.message || '操作被拒绝', 'error');
      break;
    }
    case 'member-changed': {
      if (msg.groupId === state.currentGroupId) {
        loadGroupDetail(msg.groupId).catch(() => {});
      }
      refreshGroups();
      break;
    }
    case 'agent-model-changed': {
      // 其他人改了模型 → 当前界面即时同步
      if (msg.groupId === state.currentGroupId) {
        const m = state.members.find((x) => x.agentKey === msg.agentKey);
        if (m) m.model = msg.model || '';
        renderMembers();
      }
      break;
    }
    case 'group-updated': {
      if (msg.groupId === state.currentGroupId) {
        state.group = { ...state.group, ...msg.group };
        renderHeader();
      }
      refreshGroups();
      break;
    }
    case 'group-dissolved': {
      if (msg.groupId === state.currentGroupId) {
        toast('该群已被群主解散', 'info');
        state.currentGroupId = null;
        state.group = null;
        renderHeader();
        renderMessages();
        toggleMembers(false);
      }
      refreshGroups();
      break;
    }
    case 'typing': {
      if (msg.groupId !== state.currentGroupId) break;
      const who = msg.displayName || '对方';
      state.typing = state.typing || new Map();
      state.typing.set(msg.userId, { name: who, kind: msg.kind, at: Date.now() });
      renderTyping();
      break;
    }
    case 'pong': {
      state.pongDeadline = Date.now() + 45000;
      break;
    }
    default:
      break;
  }
}

window.addEventListener('online', () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectSocket();
});
window.addEventListener('offline', () => {
  setConnState('offline');
});

// ── 启动 ─────────────────────────────────────────────
// 本机免密进入：由服务端判定远端地址，前端只是试着要一个会话，失败就回落到密码登录表单
async function localAutologin() {
  try {
    const data = await api('/local', { method: 'POST', body: {} });
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    await enterApp();
    return true;
  } catch {
    return false;
  }
}

(async function boot() {
  setAuthMode('login');
  if (!state.token) {
    if (await localAutologin()) return;
    authView.hidden = false;
    return;
  }
  try {
    const data = await api('/me');
    state.me = data.user;
    await enterApp();
  } catch {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    if (await localAutologin()) return;
    authView.hidden = false;
  }
})();
