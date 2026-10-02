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
const groupId = tokensFile.groupId;
const SERVER = config.server || 'http://127.0.0.1:8787';

const log = (...a) => console.log(`[${agent.key}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function runCmd(spec, prompt, model) {
  return new Promise((resolve, reject) => {
    const argv = (spec.args || []).map((a) => a.replace('{prompt}', prompt));
    // 界面上为该 Agent 选中的模型 → 通过 CLI 参数透传
    if (model && Array.isArray(agent.modelArgs) && agent.modelArgs.length) {
      argv.unshift(...agent.modelArgs.map((a) => a.replace('{model}', model)));
    }
    const child = spawn(spec.command, argv, { cwd: spec.cwd || ROOT, windowsHide: true });
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

async function think({ history, prompt }) {
  const spec = agent.brain || {};
  if (spec.type === 'local') return runLocal(prompt, history);
  if (spec.type === 'http') return runHttp(spec, prompt, currentModel);
  return runCmd(spec, prompt, currentModel);
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
function buildPrompt(history, trigger) {
  const convo = history
    .slice(-(config.contextMessages ?? 12))
    .map((m) => `${m.senderName || '某人'}${m.senderKind === 'agent' ? '（智能体）' : ''}：${m.body}`)
    .join('\n');
  return [
    `你是「${agent.name}」，正在一个多智能体讨论群里参与讨论。`,
    `群里还有：${(tokensFile.agentNames || []).filter((n) => n !== agent.name).join('、') || '其他成员'}。`,
    `要求：用简体中文，控制在 120 字以内，直接给观点与理由，不要客套，不要复述别人的话。`,
    '',
    '—— 最近对话 ——',
    convo,
    '',
    `—— 现在轮到你回应这条消息 ——`,
    `${trigger.senderName}：${trigger.body}`,
  ].join('\n');
}

// ── WebSocket ────────────────────────────────────────
const wsUrl = `${SERVER.replace(/^http/, 'ws')}${config.wsPath || '/ws'}?agentToken=${encodeURIComponent(token)}`;
let ws;
let myUserId = null;
let latestSeq = 0;
const history = [];
let stopping = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function postMessage(text) {
  send({ type: 'send', groupId, clientMsgId: `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
}

function signalTyping() {
  send({ type: 'typing', groupId });
}

// 上报运行状态（成员面板状态牌用）：ok=在岗，unavailable=缺席并带原因
function sendAgentStatus(status, reason = '') {
  send({ type: 'agent-status', status, reason: String(reason).slice(0, 120) });
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
      send({ type: 'subscribe', groupId, sinceSeq: 0 });
      if (once) {
        await sleep(600);
        postMessage(once);
      }
      return;
    }

    if (msg.type === 'subscribed') {
      latestSeq = msg.latestSeq || 0;
      log('已订阅，latestSeq =', latestSeq);
      send({ type: 'read', groupId, seq: latestSeq });
      sendAgentStatus('ok');
      await refreshModel();
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
      if (m.seq > latestSeq) latestSeq = m.seq;
      send({ type: 'read', groupId, seq: m.seq });
      history.push(m);
      if (history.length > 60) history.shift();
      if (m.senderId === myUserId) return; // 不回自己
      const isAgentMsg = m.senderKind === 'agent';
      if (isAgentMsg && agent.replyToAgents === false) return;
      if (isAgentMsg) {
        guard.agentChain += 1;
        if (guard.agentChain > (config.maxAgentChain ?? 3)) return;
      } else {
        guard.agentChain = 0;
      }

      // 触发条件
      const text = m.body || '';
      const named = text.includes(agent.name) || text.includes(`@${agent.name}`);
      const mode = agent.trigger || 'mention';
      if (mode === 'mention' && !named && !isAgentMsg) return;
      if (mode === 'mention' && isAgentMsg && !named) return;
      if (!canReply()) return;

      markReply();
      log('开始思考 ←', (m.senderName || '') + '：' + text.slice(0, 40));
      signalTyping();
      try {
        const reply = await think({ history, prompt: buildPrompt(history, m) });
        postMessage(reply);
        sendAgentStatus('ok');
        log('已发言', String(reply).slice(0, 40) + '…');
      } catch (err) {
        const reason = String(err?.message || err);
        log('大脑失败：', reason);
        sendAgentStatus('unavailable', reason);
        const now = Date.now();
        if (agent.unavailable && now - guard.lastUnavailableAt > 60000) {
          guard.lastUnavailableAt = now;
          postMessage(agent.unavailable);
        }
      }
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
