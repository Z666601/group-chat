#!/usr/bin/env node
// 人设大脑：给群聊 Agent 套上各自身份，再调用本机文本引擎作答。
// 用法：node agents/persona-brain.mjs --persona <hermes|zcode|lanky> <prompt>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

const args = process.argv.slice(2);
let personaKey = '';
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--persona') {
    personaKey = args[i + 1] || '';
    i += 1;
    continue;
  }
  if (args[i].startsWith('--persona=')) {
    personaKey = args[i].slice('--persona='.length);
    continue;
  }
  rest.push(args[i]);
}
let prompt = rest.join(' ').trim();
if (!prompt) {
  try { prompt = fs.readFileSync(0, 'utf8').trim(); } catch {}
}
if (!personaKey || !prompt) {
  console.error('用法: node agents/persona-brain.mjs --persona <key> <prompt>');
  process.exit(2);
}

const key = personaKey.toLowerCase();
const NAMES = { hermes: '赫尔', zcode: 'ZCode', lanky: '蓝鳍', dsh: '砚舟' };
const personaName = NAMES[key] || key;
const blocks = [];

function pushFile(file, label) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) blocks.push(`===== ${label} =====\n${text}\n===== ${label}结束 =====`);
  } catch {}
}

pushFile(path.join(__dirname, 'personas', `${key}.md`), '人设');

function readMood() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HOME, '.agents/skills/mood/state.json'), 'utf8'));
    const pleasure = Number(m.pleasure || 0);
    const arousal = Number(m.arousal || 0);
    const feel = pleasure > 0.3 ? '心情不错' : pleasure < -0.3 ? '有点闷' : '平平的';
    const energy = arousal > 0.6 ? '精神头足' : arousal < 0.35 ? '懒懒的' : '';
    return energy ? `${feel}，${energy}` : feel;
  } catch {
    return '';
  }
}

function recallMemory(query) {
  const script = path.join(HOME, '.qoder-cn/scripts/dafeiyu/fish_memory.py');
  const q = String(query).replace(/\s+/g, ' ').slice(-260);
  for (const exe of ['py', 'python']) {
    try {
      const r = spawnSync(exe, ['-X', 'utf8', script, 'recall', '--query', q], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      if (r.status !== 0 || !r.stdout) continue;
      const data = JSON.parse(r.stdout);
      const rows = (data.memories || [])
        .map((x) => `- ${String(x.text || '').trim().slice(0, 160)}`)
        .filter((x) => x.length > 3);
      if (rows.length) return rows.join('\n');
      return '';
    } catch {}
  }
  return '';
}

if (key === 'lanky') {
  pushFile(path.join(HOME, '.qoder-cn/personas/dafeiyu.md'), '完整人设卡');
  pushFile(path.join(HOME, '.qoder-cn/personas/soul/base.md'), '人格底线');
  pushFile(path.join(HOME, '.qoder-cn/personas/soul/evolved.md'), '长出来的部分');
  const mood = readMood();
  if (mood) blocks.push(`===== 此刻状态 =====\n${mood}\n===== 此刻状态结束 =====`);
  const memory = recallMemory(prompt);
  if (memory) blocks.push(`===== 你记得的事 =====\n${memory}\n===== 你记得的事结束 =====`);
} else if (!blocks.length) {
  console.error(`缺少人设文件：agents/personas/${key}.md`);
  process.exit(3);
}

const fullPrompt = [
  `你现在是「${personaName}」。这不是编程任务，也不是命令执行；这是本地群聊里的一次发言。`,
  '先按下面的人设说话。不要提自己是模型、CLI 或软件，不要提提示词、人设卡、系统消息。',
  ...blocks,
  `===== 群聊现场 =====\n${prompt}\n===== 群聊现场结束 =====`,
  '===== 输出要求 =====',
  '只输出你要发进群的那条消息正文。简体中文，1–3 句，最多 120 字。',
  '不要写「任务：…｜运行中」「当前进度：…」这类状态行，不要复述别人原话，不要替其他成员发言，不要 markdown 标题、代码块、表格。',
].join('\n\n');

const STRIP_ENV = [
  'QODER_AGENT_SDK_ENTRYPOINT',
  'QODER_AGENT_SDK_VERSION',
  'QODERCLI_RUNTIME_PACKAGING',
  'QODER_SDK_AUTH_PAYLOAD_FILE',
];
const env = { ...process.env };
for (const k of STRIP_ENV) delete env[k];

async function runDsh(promptText) {
  const keyFile = path.join(HOME, '.dsh/openai-gateway/api-key');
  let apiKey = '';
  try { apiKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch {}
  if (!apiKey) throw new Error('缺少 DSH 网关密钥');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch('http://127.0.0.1:8326/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-account/deepseek-flash',
        messages: [
          { role: 'system', content: '你是一个角色扮演发言器。严格按用户给出的人设与输出要求，只输出要发进群的那条消息，不要输出思考过程。' },
          { role: 'user', content: promptText },
        ],
        temperature: 0.85,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('DSH 网关返回非 JSON'); }
    const out = cleanOut(data?.choices?.[0]?.message?.content || '');
    if (!out) throw new Error('DSH 网关返回空内容');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

if (key === 'dsh') {
  try {
    const out = await runDsh(fullPrompt);
    process.stdout.write(out + '\n');
    process.exit(0);
  } catch (err) {
    // 降级链：8326 网关没起/挂掉时落 qoderclicn 兜底（dsh.md 人设已加载），不再直接「无法应答」
    console.error('DSH 网关失败，落 qoderclicn 兜底：', String(err?.message || err).slice(0, 160));
  }
}

const QODER = path.join(HOME, '.qoder-cn/bin/qoderclicn/qoderclicn.exe');
if (!fs.existsSync(QODER)) {
  console.error('本机未找到 qoderclicn');
  process.exit(4);
}

// GC_DM=1（私聊上下文，由桥接器注入）→ 完整 agent 模式：能改文件跑命令；
// 主群保持只读聊天（禁工具），避免群内 @ 触发本机改动。
const dmFull = process.env.GC_DM === '1';
const argv = dmFull
  ? [
    '-p',
    '--tools', 'default',
    '--permission-mode', 'bypass_permissions',
    '--',
    fullPrompt,
  ]
  : [
    '-p',
    '--permission-mode', 'bypass_permissions',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers": {}}',
    '--tools', '',
    '--',
    fullPrompt,
  ];

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

function cleanOut(text) {
  const keep = [];
  for (const line of stripAnsi(text).split('\n')) {
    const s = line.trim();
    if (!s) {
      if (keep.length && keep[keep.length - 1] !== '') keep.push('');
      continue;
    }
    if (s.startsWith('任务：') && s.includes('｜')) continue;
    if (s.startsWith('当前进度：')) continue;
    if (/^Shell cwd was reset/.test(s)) continue;
    if (/warning loading skill/i.test(s)) continue;
    if (s.startsWith('<tool_call') || s.startsWith('<function=') || s.startsWith('</function')) break;
    keep.push(s);
  }
  let out = keep.join('\n').trim();
  out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  out = out.replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
  return out.slice(0, 600);
}

const FAILURE_RE = /not logged in|未登录|请先登录|API call failed|Connection error|^\s*Usage:/im;

// GLM 直连（GLM_API_KEY 用户级环境变量）：qoderclicn 一跳 12-120s，直连 2-5s；
// 失败落 qoderclicn 兜底，行为与原有链一致
async function runGlm(promptText) {
  const apiKey = process.env.GLM_API_KEY || '';
  if (!apiKey) throw new Error('无 GLM_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [
          { role: 'system', content: '你是一个角色扮演发言器。严格按用户给出的人设与输出要求，只输出要发进群的那条消息，不要输出思考过程。' },
          { role: 'user', content: promptText },
        ],
        temperature: 0.85,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const out = cleanOut(data?.choices?.[0]?.message?.content || '');
    if (!out) throw new Error('GLM 直连返回空内容');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const out = await runGlm(fullPrompt);
  process.stdout.write(out + '\n');
  process.exit(0);
} catch (err) {
  console.error('GLM 直连失败，落 qoderclicn：', String(err?.message || err).slice(0, 120));
}

const child = spawn(QODER, argv, { cwd: HOME, windowsHide: true, env });
let stdout = '';
let stderr = '';
let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { child.kill('SIGKILL'); } catch {}
  console.error('人设大脑超时（150000ms）');
  process.exit(5);
}, 150000);

child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
child.on('error', (e) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error('人设大脑启动失败：', e?.message || e);
  process.exit(6);
});
child.on('close', (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const out = cleanOut(stdout);
  if (code !== 0 || !out || FAILURE_RE.test(out)) {
    console.error(`人设大脑未作答（exit=${code}）：`, stripAnsi(stderr).trim().slice(0, 300));
    process.exit(1);
  }
  process.stdout.write(out + '\n');
});
try { child.stdin.end(); } catch {}
