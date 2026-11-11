#!/usr/bin/env node
// 调度监视器（多脑闭环的常驻监听钩子）：盯群消息流，发现成员间讨论就起一次性判定任务，
// 结论落盘；判定「影响在办任务」时以独立成员「调度台」身份经 WS 报警（不冒用主人账号）。
// 主人随时插话即最高优先级。
//
// 纯规则监听零模型消耗；只有触发判定时才调一次模型（verdict-brain.mjs）。
// 与桥接器一样走 GC_* 环境缝隙（GC_AGENTS_CONFIG/GC_TOKENS_FILE），自检可整体隔离。
//
// 用法：node agents/discussion-monitor.mjs
// 环境变量：GC_MONITOR_STATE / GC_DISCUSSION_DIR / GC_LEDGER_PATH / GC_VERDICT_SCRIPT /
//           GC_POLL_MS / GC_WINDOW_MS / GC_COOLDOWN_MS / GC_ADMIN_TOKEN
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.GC_AGENTS_CONFIG || path.join(__dirname, 'agents.config.json');
const TOKENS_PATH = process.env.GC_TOKENS_FILE || path.join(__dirname, '.tokens.local.json');
const STATE_PATH = process.env.GC_MONITOR_STATE || path.join(ROOT, 'data', 'monitor-state.json');
const DISC_DIR = process.env.GC_DISCUSSION_DIR || path.join(ROOT, 'data', 'discussions');
const LEDGER_PATH = process.env.GC_LEDGER_PATH || path.join(ROOT, 'data', 'task-ledger.json');
const VERDICT_SCRIPT = process.env.GC_VERDICT_SCRIPT || path.join(__dirname, 'verdict-brain.mjs');
const ALERT_PREFIX = '〔调度台〕';
const MONITOR_AGENT_KEY = 'monitor';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const mon = config.monitor || {};
const POLL_MS = Number(process.env.GC_POLL_MS || mon.pollMs || 2500);
const WINDOW_MS = Number(process.env.GC_WINDOW_MS || mon.windowMs || 120000);
const COOLDOWN_MS = Number(process.env.GC_COOLDOWN_MS || mon.cooldownMs || 600000);

const tokensFile = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
const ownerToken = tokensFile.ownerToken;
const mainGroupId = tokensFile.groupId;
const dmByGroup = new Map(Object.entries(tokensFile.dm || {}).map(([k, v]) => [v.groupId, k]));
if (!ownerToken || !mainGroupId) {
  console.error('[monitor] 令牌文件缺 ownerToken 或 groupId，先跑 provision.mjs');
  process.exit(1);
}
const SERVER = config.server || 'http://127.0.0.1:8787';

const log = (...a) => console.log('[monitor]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 状态（重启不重扫历史：lastSeqs 落盘）──────────────
let state = { lastSeqs: {}, lastTriggerAt: 0 };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── 调度台身份：admin 绑定独立成员，报警不冒用主人账号 ──
function adminTokenCandidates() {
  const out = [];
  if (process.env.GC_ADMIN_TOKEN) out.push(process.env.GC_ADMIN_TOKEN);
  if (process.env.ADMIN_TOKEN) out.push(process.env.ADMIN_TOKEN);
  const f = process.env.ADMIN_TOKEN_FILE || path.join(__dirname, '.admin.token');
  try { out.push(fs.readFileSync(f, 'utf8').trim()); } catch {}
  // start-dev 启动链的 server 令牌在 .env 里
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.+?)\s*$/);
      if (m && m[1]) out.push(m[1]);
    }
  } catch {}
  return out.filter(Boolean);
}

async function ensureMonitorAgent() {
  if (state.monitorToken && state.monitorUserId) return;
  const admin = adminTokenCandidates();
  if (!admin.length) {
    log('警告：没有管理令牌（GC_ADMIN_TOKEN/ADMIN_TOKEN/.admin.token），调度台身份建不了，报警功能停用（判定照常落盘）');
    return;
  }
  for (const tk of admin) {
    try {
      const res = await fetch(`${SERVER}/api/admin/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': tk },
        body: JSON.stringify({
          groupId: mainGroupId,
          agentKey: MONITOR_AGENT_KEY,
          displayName: '调度台',
          avatar: '🛰',
          supportsModel: false,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      state.monitorToken = data.token;
      state.monitorUserId = data.userId;
      saveState();
      log(`调度台身份就绪：${data.displayName}（${data.userId}）`);
      return;
    } catch { /* 试下一个候选 */ }
  }
  log('警告：调度台身份绑定失败（管理令牌全部无效），报警功能停用（判定照常落盘）');
}

// 报警走 WS（agent 令牌走 REST 是 401）
let alertWs = null;
function postAlert(text) {
  return new Promise((resolve) => {
    if (!state.monitorToken) return resolve(false);
    const clientMsgId = `mon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const timer = setTimeout(() => { try { alertWs?.close(); } catch {} finish(false); }, 10000);
    try {
      alertWs = new WebSocket(`${SERVER.replace(/^http/, 'ws')}/ws?agentToken=${encodeURIComponent(state.monitorToken)}`);
      alertWs.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ready' && !m.user) {
          // 令牌失效（被重绑/服务重装）→ 清掉重绑，本次报警放弃
          clearTimeout(timer);
          state.monitorToken = null;
          state.monitorUserId = null;
          saveState();
          try { alertWs.close(); } catch {}
          finish(false);
        }
        if (m.type === 'ack' && m.clientMsgId === clientMsgId) {
          clearTimeout(timer);
          try { alertWs.close(); } catch {}
          finish(true);
        }
      });
      alertWs.addEventListener('open', () => {
        alertWs.send(JSON.stringify({ type: 'send', groupId: mainGroupId, clientMsgId, text }));
      });
      alertWs.addEventListener('error', () => { clearTimeout(timer); finish(false); });
      alertWs.addEventListener('close', () => { clearTimeout(timer); finish(false); });
    } catch { clearTimeout(timer); finish(false); }
  });
}

// ── 任务台账（谁在干什么）────────────────────────────
function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return { updatedAt: null, tasks: [] }; }
}
function saveLedger(l) {
  l.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  // 原子写：先落临时文件再改名，避免与人工编辑互踩出半截 JSON
  const tmp = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, LEDGER_PATH);
}

// 派活动词判定：宁可漏收，不把寒暄记成任务
const TASK_VERBS = ['做', '改', '修', '写', '实现', '交付', '处理', '部署', '升级', '排查', '调研', '开发', '整理', '分析', '检查', '测试', '上线', '翻译', 'review', 'Review'];
function looksLikeTask(text) {
  return TASK_VERBS.some((v) => text.includes(v));
}

function claimTask(agentKey, m) {
  const body = String(m.body || '').trim();
  if (!looksLikeTask(body)) return;
  const ledger = readLedger();
  if (ledger.tasks.some((t) => t.msgId === m.id)) return;
  ledger.tasks.push({
    id: `t_${m.id.slice(0, 12)}`,
    agent: agentKey,
    title: body.replace(/\s+/g, ' ').slice(0, 40),
    digest: body.replace(/\s+/g, ' ').slice(0, 120),
    status: 'active',
    msgId: m.id,
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
  });
  saveLedger(ledger);
  log(`台账收活：${agentKey} ← ${body.slice(0, 30)}`);
}

// 主群里主人点名某一家派活（只点名一家才算，多家同时点名属于讨论，交给判定）。
// 以【/〔开头的消息是公告通报（群内既定格式），不是派活，豁免。
function claimIfSoloMention(m) {
  if (m.senderKind === 'agent') return;
  const text = (m.body || '').trim();
  if (/^[【〔]/.test(text)) return;
  const agents = (config.agents || []);
  const hit = agents.filter((a) => [a.name, ...(a.aliases || [])].some((n) => n && text.includes(n)));
  if (hit.length !== 1) return;
  claimTask(hit[0].key, m);
}

// ── 拉消息（REST 轮询，owner 身份读，不占 WS 席位）────
async function fetchMessages(gid) {
  const res = await fetch(`${SERVER}/api/groups/${gid}/messages?limit=50`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollNew(gid) {
  const data = await fetchMessages(gid);
  const last = state.lastSeqs[gid];
  if (last == null) {
    // 首轮基线 = 当前最新 seq：不重扫历史
    state.lastSeqs[gid] = data.latestSeq || 0;
    return [];
  }
  return (data.messages || [])
    .filter((m) => Number(m.seq) > last)
    .sort((a, b) => a.seq - b.seq);
}

// ── 讨论检测（纯规则）：窗口内 ≥2 条 agent 消息且来自 ≥2 家 ──
// 噪音不计入：桥接器的 unavailable 失败话术（今晚砚舟连发 5 条就白触发过一场判定）
const unavailableSet = new Set((config.agents || []).map((a) => a.unavailable).filter(Boolean));
function isNoise(m) {
  const body = String(m.body || '');
  return body.startsWith('无法应答：') || unavailableSet.has(body);
}

const agentMsgs = []; // { at, name, body }
let lastServerUnreachableAt = 0;

function detectDiscussion(now) {
  const inWindow = agentMsgs.filter((e) => now - e.at <= WINDOW_MS);
  const senders = new Set(inWindow.map((e) => e.name));
  return inWindow.length >= 2 && senders.size >= 2 ? inWindow : null;
}

// ── 判定任务：起一次性子进程读讨论 + 台账 ────────────
async function runVerdict({ transcript, ledger }) {
  const child = spawn(process.execPath, ['--no-warnings', VERDICT_SCRIPT], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {}); // 判定脚本提前退出时避免 EPIPE 崩溃
  child.stdin.write(JSON.stringify({ transcript, ledger }));
  child.stdin.end();
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d.toString('utf8')));
  child.stderr.on('data', (d) => (err += d.toString('utf8')));
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, 180000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        log('判定进程失败：', String(err).slice(0, 160));
        return resolve(null);
      }
      resolve(out.trim());
    });
  });
  if (result == null) return null;
  try {
    const s = result.replace(/```json/gi, '```').replace(/```/g, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no json');
    const verdict = JSON.parse(s.slice(a, b + 1));
    if (typeof verdict.affected !== 'boolean') throw new Error('bad affected');
    if (!Array.isArray(verdict.impacts)) verdict.impacts = [];
    return verdict;
  } catch (e) {
    log('判定输出不可解析：', String(e?.message || e), '原始：', result.slice(0, 120));
    return null;
  }
}

async function triggerDiscussion(discussion, now) {
  state.lastTriggerAt = now;
  saveState();
  const ts = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(DISC_DIR, ts);
  fs.mkdirSync(DISC_DIR, { recursive: true });

  const data = await fetchMessages(mainGroupId);
  const convo = (data.messages || [])
    .map((m) => `${m.senderName || '某人'}：${m.body}`)
    .join('\n');
  const ledger = readLedger();
  // 判定只看在办任务：完结/作废的不进判定输入（台账不腐烂，判定才准）
  const activeLedger = { ...ledger, tasks: ledger.tasks.filter((t) => t.status === 'active') };
  const transcript = [
    `—— 讨论窗口（${discussion.length} 条） ——`,
    ...discussion.map((e) => `${e.name}：${e.body}`),
    '',
    '—— 群内最近上下文 ——',
    convo,
  ].join('\n');
  fs.writeFileSync(`${base}.md`, `# 讨论档案 ${new Date(now).toISOString()}\n\n${transcript}\n\n## 台账快照（active）\n${JSON.stringify(activeLedger.tasks, null, 2)}\n`);
  log(`检测到成员讨论（${discussion.length} 条 / ${discussion.map((e) => e.name).join('、')}），起判定任务…`);

  const verdict = await runVerdict({ transcript, ledger: activeLedger });
  fs.writeFileSync(`${base}.verdict.json`, JSON.stringify({
    at: new Date().toISOString(),
    discussionCount: discussion.length,
    verdict,
    ledgerTasks: activeLedger.tasks,
  }, null, 2));

  if (!verdict) return; // 判定失败：档案里留 null，安静降级不报警
  log('判定：', JSON.stringify(verdict));
  if (!verdict.affected) return;
  // 报警文案不带成员名（避免 @ 语义触发桥接器接话），细节全在档案里；
  // 以调度台身份发（非主人账号），消息开头自证是系统自动消息
  const sent = await postAlert(
    `${ALERT_PREFIX}（系统自动消息，非主人发言）监听到成员讨论（${discussion.length} 条），判定影响在办任务 ${verdict.impacts.length} 项。` +
    `理由：${String(verdict.reason || '').slice(0, 80)}。清单与讨论原文：${path.relative(ROOT, `${base}.verdict.json`)}。请主人过目定夺。`,
  );
  if (!sent) log('报警发送失败（调度台通道不可用），档案已落盘待查');
}

// ── 主循环 ───────────────────────────────────────────
let polling = false;

async function tick() {
  if (polling) return;
  polling = true;
  try {
    for (const [gid, agentKey] of dmByGroup) {
      const fresh = await pollNew(gid);
      for (const m of fresh) {
        if (m.senderKind !== 'agent') claimTask(agentKey, m); // 主人私聊派活 → 记台账
      }
    }
    const freshMain = await pollNew(mainGroupId);
    const now = Date.now();
    for (const m of freshMain) {
      if (m.senderId === state.monitorUserId) continue; // 自己的报警不进窗口（防反馈环）
      if (m.senderKind === 'agent') {
        if (isNoise(m)) continue; // 故障话术不算讨论
        agentMsgs.push({ at: Date.parse(m.createdAt) || now, name: m.senderName || m.senderUsername || '?', body: m.body || '' });
      } else {
        claimIfSoloMention(m);
      }
    }
    while (agentMsgs.length && now - agentMsgs[0].at > 3600000) agentMsgs.shift();
    if (now - state.lastTriggerAt > COOLDOWN_MS) {
      const discussion = detectDiscussion(now);
      if (discussion) await triggerDiscussion(discussion, now);
    }
    saveState();
  } catch (err) {
    if (Date.now() - lastServerUnreachableAt > 60000) {
      lastServerUnreachableAt = Date.now();
      log('轮询失败（服务不可达？60s 内不重复报）：', String(err?.message || err).slice(0, 120));
    }
  } finally {
    polling = false;
  }
}

await ensureMonitorAgent();
log(`启动：poll=${POLL_MS}ms window=${WINDOW_MS}ms cooldown=${COOLDOWN_MS}ms 判定脚本=${path.basename(VERDICT_SCRIPT)}`);
log(`盯群：主群 ${mainGroupId} + 私聊 ${dmByGroup.size} 个；报警身份=${state.monitorToken ? '调度台（独立成员）' : '无（绑定失败，仅落盘）'}`);
let stopping = false;
process.on('SIGINT', () => { stopping = true; try { alertWs?.close(); } catch {} saveState(); process.exit(0); });
for (;;) {
  if (stopping) break;
  await tick();
  await sleep(POLL_MS);
}
