// 通用 Agent 桥接器：把任意「大脑」接入群聊，作为机器人成员参与讨论
//
// 用法：
//   node agents/bridge.mjs --key=hermes           # 单个 agent
//   node agents/bridge.mjs --key=hermes --once="大家好"  # 连上后先发言一次
//
// 大脑类型（agents.config.json 里配置）：
//   cmd   —— 调用本机命令行，{prompt} 占位符会被替换（同时通过 stdin 传入），stdout 作为回复
//   http  —— POST 到 HTTP 接口，按响应路径取文本
//   local —— 内置本机演示大脑，不依赖任何外部模型
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.GC_AGENTS_CONFIG || path.join(__dirname, 'agents.config.json');
const TOKENS_PATH = process.env.GC_TOKENS_FILE || path.join(__dirname, '.tokens.local.json');

// 从 AI 会话终端里手动拉起桥接器时会继承 Qoder Agent SDK 的入口标记，
// 子进程 qoderclicn 见到它就报 sdk_invalid_args 直接退出（exit=4），群里只剩「无法应答」。
const SDK_POLLUTION = ['QODER_AGENT_SDK_ENTRYPOINT', 'QODER_AGENT_SDK_VERSION', 'QODERCLI_RUNTIME_PACKAGING'];
const strippedEnv = SDK_POLLUTION.filter((k) => k in process.env);
for (const k of strippedEnv) delete process.env[k];
if (strippedEnv.length) console.log('[bridge] 已剥离 SDK 污染变量：', strippedEnv.join(', '));

const args = process.argv.slice(2);
const argOf = (name, def = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const idx = args.indexOf(hit);
  return args[idx + 1] ?? def;
};
const key = argOf('key');
const once = argOf('once');
if (!key) {
  console.error('用法: node agents/bridge.mjs --key=<agentKey> [--once="开局发言"]');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const agent = config.agents.find((a) => a.key === key);
if (!agent) {
  console.error(`配置里没有 agent: ${key}；可选：${config.agents.map((a) => a.key).join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(TOKENS_PATH)) {
  console.error(`缺少 ${TOKENS_PATH}，请先运行：node agents/provision.mjs`);
  process.exit(1);
}
const tokensFile = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
const token = tokensFile.tokens[key];
if (!token) {
  console.error(`令牌文件里没有 ${key} 的令牌，请先运行 node agents/provision.mjs`);
  process.exit(1);
}
const mainGroupId = tokensFile.groupId;
const dmInfo = tokensFile.dm?.[key] || null;
const dmGroupId = dmInfo?.groupId || null;
const allGroups = [mainGroupId, dmGroupId].filter(Boolean);
const SERVER = config.server || 'http://127.0.0.1:8787';

const log = (...a) => console.log(`[${agent.key}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 父 supervisor（start-all）死后 stdout pipe 断裂，写日志会 EPIPE 崩掉进程——
// 桥必须活得比父久，等下一个 supervisor 来接管
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {});
}

// ── 桌面应用白名单：只认 apps.json 里列出的目标，绝不执行任意路径 ──
let APP_LIST = [];
try {
  APP_LIST = JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.json'), 'utf8')).apps || [];
} catch {}

function parseOpenCommand(text) {
  const clean = String(text).replace(/^\s*@\S+\s*/, '').trim();
  if (!clean || clean.length > 40) return null;
  const m = clean.match(/^(?:帮我|给我|请|麻烦)?\s*(?:打开|开一下|启动|运行)\s*(?:一下)?\s*[:：]?\s*(.+)$/);
  if (!m) return null;
  const want = m[1].replace(/[。！!，,\s]+$/g, '').trim().toLowerCase();
  if (!want) return null;
  const hit = APP_LIST.find((a) =>
    [a.name, ...(a.aliases || [])].some((n) => {
      const k = String(n).toLowerCase();
      return want === k || want.startsWith(k);
    }),
  );
  return hit ? { name: hit.name, target: hit.target } : null;
}

function launchApp(target) {
  const child = spawn('explorer.exe', [target], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref();
}

// ── 发言节流 / 防打架 ────────────────────────────────
const guard = {
  lastReplyAt: 0,
  replies: [],
  agentChain: 0,
  lastUnavailableAt: 0,
};

function canReply() {
  const now = Date.now();
  if (now - guard.lastReplyAt < (config.replyCooldownMs ?? 2500)) return false;
  guard.replies = guard.replies.filter((t) => now - t < 60000);
  if (guard.replies.length >= (config.maxRepliesPerMinute ?? 8)) return false;
  return true;
}

function markReply() {
  guard.lastReplyAt = Date.now();
  guard.replies.push(Date.now());
}

// ── 运行台账上报（留痕 + 用量统计，失败不阻塞发言）──
function reportRun({ trigger, ok, error = null, durationMs, promptDigest = '' }) {
  fetch(`${SERVER}/api/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify({ trigger, ok, error, durationMs, model: currentModel, promptDigest }),
  }).catch(() => {});
}

// ── 忙锁：大脑思考中不接新触发，防止同一问题被并发处理 ──
let busy = false;

// ── 例程心跳：按配置定时让 Agent 主动冒泡（默认关）──
if (agent.routine?.intervalMinutes > 0) {
  const routine = agent.routine;
  // 下限 5 分钟：防误配成极小值刷屏（mention 路径另有冷却/配额闸门，例程只有这一个闸）
  const intervalMs = Math.max(5, routine.intervalMinutes) * 60_000;
  setInterval(async () => {
    if (stopping || busy || !ws || ws.readyState !== WebSocket.OPEN) return;
    busy = true;
    const t0 = Date.now();
    log('例程触发：', routine.prompt || '例行冒泡');
    try {
      const reply = await think({
        history,
        prompt: [
          `你是「${agent.name}」，这是一次例行心跳，不是有人提问。`,
          routine.prompt || '用一两句话向群里简要汇报你的状态或补充一个观点。',
          '要求：用简体中文，不超过 60 字。',
        ].join('\n'),
      });
      postMessage(reply);
      reportRun({ trigger: 'routine', ok: true, durationMs: Date.now() - t0 });
    } catch (err) {
      reportRun({ trigger: 'routine', ok: false, error: String(err?.message || err), durationMs: Date.now() - t0 });
    } finally {
      busy = false;
    }
  }, intervalMs);
}

// ── 大脑实现 ─────────────────────────────────────────
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

// 命令类大脑的「看起来有输出、实际上是失败/帮助」识别
const CMD_FAILURE_PATTERNS = [
  /API call failed/i,
  /Connection error/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /not logged in|未登录|请先登录/i,
  /^Usage:/im,
  /^\s*Usage:\s*$/im,
];

function looksLikeFailure(text) {
  const t = String(text).trim();
  if (!t) return true;
  return CMD_FAILURE_PATTERNS.some((re) => re.test(t));
}

function runCmd(spec, prompt, model, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const argv = (spec.args || []).map((a) => a.replace('{prompt}', prompt));
    // 界面上为该 Agent 选中的模型 → 通过 CLI 参数透传
    if (model && Array.isArray(agent.modelArgs) && agent.modelArgs.length) {
      argv.unshift(...agent.modelArgs.map((a) => a.replace('{model}', model)));
    }
    const child = spawn(spec.command, argv, {
      cwd: spec.cwd || ROOT,
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`大脑超时（${spec.timeoutMs || 120000}ms）`));
    }, spec.timeoutMs || 120000);
    if (spec.stdin !== false) {
      try { child.stdin.write(prompt); child.stdin.end(); } catch {}
    }
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stripAnsi(out).trim();
      if (!text) {
        return reject(new Error(`大脑未返回内容（exit=${code}）${stripAnsi(err).trim().slice(0, 200)}`));
      }
      if (looksLikeFailure(text)) {
        return reject(new Error(`大脑实际未作答：${text.replace(/\s+/g, ' ').slice(0, 160)}`));
      }
      resolve(text);
    });
  });
}

function getByPath(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((acc, k) => (acc == null ? acc : acc[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

function readTokenFile(spec) {
  if (!spec.tokenFile) return null;
  try {
    const raw = fs.readFileSync(spec.tokenFile, 'utf8');
    if (spec.tokenJsonPath) {
      const j = JSON.parse(raw);
      const v = getByPath(j, spec.tokenJsonPath);
      return v ? String(v) : null;
    }
    return raw.trim();
  } catch {
    return null;
  }
}

async function runHttp(spec, prompt, model) {
  const rawHeaders = JSON.stringify(spec.headers || {}).replace(/\{model\}/g, model || '');
  const headers = JSON.parse(rawHeaders);
  const token = readTokenFile(spec);
  if (token) headers.authorization = `Bearer ${token}`;
  const rawBody = JSON.stringify(spec.body || {})
    .replace(/\{prompt\}/g, JSON.stringify(prompt).slice(1, -1))
    .replace(/\{model\}/g, model || '');
  const body = JSON.parse(rawBody);
  // 未选模型时，不让空的 model 字段污染请求体
  if (!model && body && typeof body === 'object' && 'model' in body && !body.model) delete body.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 180000);
  try {
    const res = await fetch(spec.url, {
      method: spec.method || 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    let data;
    try { data = JSON.parse(text); } catch { return text.slice(0, 4000); }
    const v = spec.responsePath ? getByPath(data, spec.responsePath) : data;
    const out = typeof v === 'string' ? v : JSON.stringify(v);
    if (!out || !out.trim()) throw new Error('接口返回内容为空');
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 本机演示大脑：不依赖外部模型，基于对话内容给出结构化意见，用于验证链路 */
function runLocal(prompt, history) {
  const lastHuman = [...history].reverse().find((m) => m.senderKind !== 'agent') || { body: '' };
  const topic = (lastHuman.body || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '当前话题';
  const keywords = [
    [/风险|隐患|失败|坑/, '风险'],
    [/成本|预算|费用|投入/, '成本'],
    [/时间|排期|多久|进度|上线/, '时间'],
    [/方案|怎么|如何|实现|设计/, '方案'],
    [/数据|指标|统计|数量/, '数据'],
  ];
  const looks = keywords.filter(([re]) => re.test(lastHuman.body || '')).map(([, label]) => label);
  const lens = looks.length ? looks : ['方案'];
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return [
    `【本机演示大脑 · ${stamp}】就「${topic}」我补充三点：`,
    `1. 视角：${lens.join(' / ')} 是这里最需要先钉住的维度。`,
    `2. 判断：先把最小可验证路径跑通，再叠加复杂度；不要在上线前一次性引入全部变量。`,
    `3. 建议：给出一个可检查的验收口径，并明确谁在什么时候产出证据。`,
    `（说明：本回复由内置规则大脑生成，用于证明多智能体同群链路可用；接入真实模型后替换即可。）`,
  ].join('\n');
}

async function think({ history, prompt, gid = mainGroupId }) {
  const spec = agent.brain || {};
  // 私聊上下文标记：大脑据此启用完整 agent 能力（能改文件跑命令），主群保持只读聊天
  const dmEnv = gid === dmGroupId ? { GC_DM: '1' } : null;
  try {
    if (spec.type === 'local') return await runLocal(prompt, history);
    if (spec.type === 'http') return await runHttp(spec, prompt, currentModel);
    return await runCmd(spec, prompt, currentModel, dmEnv);
  } catch (err) {
    // 降级链：主大脑挂掉（限流/超时/CLI 崩）时按 fallback 配置换通道重试一次，
    // 成功则以「（tag作答）」前缀发言，群里能看出这轮不是主模型答的。
    // local 演示大脑没有降级的意义，失败原样抛出走「无法应答」话术。
    const fb = agent.fallback;
    if (!fb || spec.type === 'local') throw err;
    log('主大脑失败，尝试降级链：', String(err?.message || err).slice(0, 100));
    const text = fb.type === 'http'
      ? await runHttp(fb, prompt, currentModel)
      : await runCmd(fb, prompt, currentModel, dmEnv);
    return `（${fb.tag || '降级通道'}作答）\n${text}`;
  }
}

// ── 当前所选模型（由界面设置，存在服务端）──────────
let currentModel = '';

async function refreshModel() {
  if (agent.supportsModel === false) return;
  try {
    const res = await fetch(`${SERVER}/api/agent/context?limit=1`, {
      headers: { 'x-agent-token': token },
    });
    if (!res.ok) return;
    const data = await res.json();
    const m = data?.agent?.model || '';
    if (m !== currentModel) {
      currentModel = m;
      log('当前模型：', currentModel || '（未指定，使用各自默认）');
    }
  } catch {
    /* 忽略 */
  }
}

// ── 提示词构造 ───────────────────────────────────────
function buildPrompt(history, trigger, gid = mainGroupId, { queuedCount = 0 } = {}) {
  const isDm = gid === dmGroupId;
  const convo = history
    .slice(-(config.contextMessages ?? 12))
    .map((m) => `${m.senderName || '某人'}${m.senderKind === 'agent' ? '（智能体）' : ''}：${m.body}`)
    .join('\n');
  return [
    isDm
      ? `你是「${agent.name}」，正在和主人一对一私聊，只有你们两个人。主人的请求就是给你下达的任务：直接动手完成（你有完整的本机 agent 能力，可以读写文件、执行命令），做完汇报结果；聊不动手的事时正常对话。`
      : `你是「${agent.name}」，正在一个多智能体讨论群里参与讨论。`,
    ...(isDm ? [] : [`群里还有：${(tokensFile.agentNames || []).filter((n) => n !== agent.name).join('、') || '其他成员'}。`]),
    ...(queuedCount > 1
      ? [`（你处理上一个任务期间，这边又来了 ${queuedCount} 条消息，已包含在下面的最近对话里；请先回应最新的这条。）`]
      : []),
    isDm
      ? `要求：用简体中文，直接交付结果与关键证据，不要客套；任务做不完就说明卡在哪。`
      : `要求：用简体中文，控制在 120 字以内，直接给观点与理由，不要客套，不要复述别人的话。`,
    '',
    '—— 最近对话 ——',
    convo,
    '',
    `—— 现在轮到你回应这条消息 ——`,
    `${trigger.senderName}：${trigger.body}`,
  ].join('\n');
}

// ── 会议模式：monitor 写 meeting-mode.json（唯一写方），桥 1s 缓存只读；
// 会议期间成员间消息互相触发（不再要求点名），链长/冷却闸门照常生效 ──
const MEETING_PATH = process.env.GC_MEETING_PATH || path.join(ROOT, 'data', 'meeting-mode.json');
let meetingCache = { at: 0, active: false };
function meetingActive() {
  const now = Date.now();
  if (now - meetingCache.at < 1000) return meetingCache.active;
  try {
    const m = JSON.parse(fs.readFileSync(MEETING_PATH, 'utf8'));
    const active = !!m.active && Date.parse(m.endTime) > now;
    if (active && !meetingCache.active) guard.agentChain = 0; // 开会瞬间重置链长，别让历史占额度
    meetingCache = { at: now, active };
  } catch {
    meetingCache = { at: now, active: false };
  }
  return meetingCache.active;
}

// ── WebSocket ────────────────────────────────────────
const wsUrl = `${SERVER.replace(/^http/, 'ws')}${config.wsPath || '/ws'}?agentToken=${encodeURIComponent(token)}`;
let ws;
let myUserId = null;
const latestSeqs = new Map();
const histories = new Map();
let subscribedOnce = false;
let stopping = false;

function historyOf(gid) {
  let h = histories.get(gid);
  if (!h) {
    h = [];
    histories.set(gid, h);
  }
  return h;
}

// 忙时排队：大脑还在跑上一件任务时，不丢新消息；跑完按群依次处理，同群只保留最新一条并计数
const pendingTriggers = new Map(); // gid -> { message, count }
let drainTimer = null;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function postMessage(text, gid = mainGroupId) {
  send({ type: 'send', groupId: gid, clientMsgId: `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
}

function signalTyping(gid = mainGroupId) {
  send({ type: 'typing', groupId: gid });
}

// 上报运行状态（成员面板状态牌用）：ok=在岗，unavailable=缺席并带原因
function sendAgentStatus(status, reason = '') {
  send({ type: 'agent-status', status, reason: String(reason).slice(0, 120) });
}

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (busy || !pendingTriggers.size) return;
    const entry = pendingTriggers.entries().next().value;
    if (!entry) return;
    const [gid, item] = entry;
    pendingTriggers.delete(gid);
    log('处理排队消息：', item.count, '条，', gid === dmGroupId ? '私聊' : '主群');
    processTrigger(item.message, gid, { queued: true, queuedCount: item.count }).catch(() => {});
  }, 400);
}

async function processTrigger(m, gid, { queued = false, queuedCount = 0 } = {}) {
  const text = m.body || '';
  const isDm = gid === dmGroupId;
  const hist = historyOf(gid);
  const promptDigest = `${m.senderName || ''}：${text.slice(0, 80)}`;

  // 打开桌面应用：只认人类消息 + apps.json 白名单
  if (m.senderKind !== 'agent') {
    const action = parseOpenCommand(text);
    if (action) {
      markReply();
      log('执行打开：', action.name);
      signalTyping(gid);
      busy = true;
      const t0 = Date.now();
      try {
        launchApp(action.target);
        postMessage(`已打开：${action.name}`, gid);
        sendAgentStatus('ok');
        reportRun({ trigger: 'action', ok: true, durationMs: Date.now() - t0, promptDigest: `打开 ${action.name}` });
      } catch (err) {
        const reason = String(err?.message || err);
        postMessage(`打开失败：${action.name}（${reason}）`, gid);
        sendAgentStatus('unavailable', reason);
        reportRun({ trigger: 'action', ok: false, error: reason, durationMs: Date.now() - t0, promptDigest: `打开 ${action.name}` });
      } finally {
        busy = false;
        scheduleDrain();
      }
      return;
    }
  }

  markReply();
  log(queued ? '处理排队消息 ←' : '开始思考 ←', (m.senderName || '') + '：' + text.slice(0, 40));
  signalTyping(gid);
  busy = true;
  const t0 = Date.now();
  try {
    const reply = await think({ history: hist, prompt: buildPrompt(hist, m, gid, { queuedCount }), gid });
    // 话题继承：触发消息带 #话题（服务端解析在 m.topic），回复开头拼回同款标签，筛选条才能把讨论串起来
    const topicPrefix = gid === mainGroupId && m.topic ? `#${m.topic} ` : '';
    postMessage(topicPrefix + reply, gid);
    sendAgentStatus('ok');
    reportRun({ trigger: isDm ? 'dm' : 'mention', ok: true, durationMs: Date.now() - t0, promptDigest });
    log('已发言', String(reply).slice(0, 40) + '…');
  } catch (err) {
    const reason = String(err?.message || err);
    log('大脑失败：', reason);
    sendAgentStatus('unavailable', reason);
    reportRun({ trigger: isDm ? 'dm' : 'mention', ok: false, error: reason, durationMs: Date.now() - t0, promptDigest });
    const now = Date.now();
    if (agent.unavailable && now - guard.lastUnavailableAt > 60000) {
      guard.lastUnavailableAt = now;
      postMessage(agent.unavailable, gid);
    }
  } finally {
    busy = false;
    scheduleDrain();
  }
}

function connect() {
  ws = new WebSocket(wsUrl);
  let readyInfo = null;

  ws.addEventListener('open', () => log('已连接', SERVER));
  ws.addEventListener('error', (e) => log('连接错误', e?.message || ''));

  ws.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'ready') {
      if (!msg.user) { log('鉴权失败：', msg.error); process.exit(2); }
      myUserId = msg.user.id;
      log('身份就绪：', msg.user.displayName);
      for (const gid of allGroups) send({ type: 'subscribe', groupId: gid, sinceSeq: 0 });
      if (once) {
        await sleep(600);
        postMessage(once);
      }
      return;
    }

    if (msg.type === 'subscribed') {
      const gid = msg.groupId || mainGroupId;
      latestSeqs.set(gid, msg.latestSeq || 0);
      log(gid === dmGroupId ? '已订阅私聊群，latestSeq =' : '已订阅，latestSeq =', msg.latestSeq || 0);
      send({ type: 'read', groupId: gid, seq: msg.latestSeq || 0 });
      sendAgentStatus('ok');
      if (!subscribedOnce) {
        subscribedOnce = true;
        await refreshModel();
      }
      return;
    }

    if (msg.type === 'agent-model-changed') {
      if (msg.agentKey === agent.key) {
        currentModel = msg.model || '';
        log('模型已切换为：', currentModel || '（未指定）');
      }
      return;
    }

    if (msg.type === 'message') {
      const m = msg.message;
      const gid = m.groupId || mainGroupId;
      if (m.seq > (latestSeqs.get(gid) || 0)) latestSeqs.set(gid, m.seq);
      send({ type: 'read', groupId: gid, seq: m.seq });
      const hist = historyOf(gid);
      hist.push(m);
      if (hist.length > 60) hist.shift();
      if (m.senderId === myUserId) return; // 不回自己
      const isAgentMsg = m.senderKind === 'agent';
      const meeting = meetingActive() && gid !== dmGroupId; // 会议只作用于主群，私聊不受影响
      if (isAgentMsg && agent.replyToAgents === false && !meeting) return;
      if (isAgentMsg) {
        guard.agentChain += 1;
        // 会议中不受链长限制（否则全员说满 3 句就集体沉默、会议僵死），由调度台的轮次上限+超时兜底
        if (guard.agentChain > (config.maxAgentChain ?? 3) && !meeting) return;
      } else {
        guard.agentChain = 0;
      }

      // 触发条件：主群按 mention，私聊群任意人类消息都触发；会议期间成员消息互相触发
      const text = m.body || '';
      const names = [agent.name, ...(agent.aliases || [])].filter(Boolean);
      const named = names.some((n) => text.includes(n) || text.includes(`@${n}`));
      const isDm = gid === dmGroupId;
      const mode = isDm ? 'all' : agent.trigger || 'mention';
      if (mode === 'mention' && !named && !isAgentMsg) return;
      if (mode === 'mention' && isAgentMsg && !named && !meeting) return;
      // 忙时排队，不丢消息：大脑跑完上一件任务后再处理，同群只留最新一条并计数
      if (busy) {
        const prev = pendingTriggers.get(gid);
        const count = (prev?.count || 0) + 1;
        pendingTriggers.set(gid, { message: m, count });
        log('上一轮还没跑完，已排队（' + count + ' 条）：', text.slice(0, 30));
        return;
      }
      if (!canReply()) return;
      processTrigger(m, gid, { queued: false }).catch(() => {});
      return;
    }

    if (msg.type === 'error') {
      log('服务端拒绝：', msg.code, msg.message);
    }
  });

  ws.addEventListener('close', () => {
    if (stopping) return;
    log('连接断开，3 秒后重连…');
    setTimeout(() => { if (!stopping) connect(); }, 3000);
  });
}

process.on('SIGINT', () => { stopping = true; try { ws.close(); } catch {} process.exit(0); });
connect();
