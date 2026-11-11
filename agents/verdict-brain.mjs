#!/usr/bin/env node
// 判定大脑：一次性任务——读一段群聊讨论 + 任务台账，判断讨论是否影响在办任务。
// 输入（stdin JSON）：{ transcript: "讨论原文", ledger: { tasks: [...] } }
// 输出（stdout）：严格 JSON {"affected":bool,"reason":"…","impacts":[{"agent","task","why"}]}
// 通道：DSH 网关（deepseek-flash）→ 失败落 qoderclicn 一次性会话（空工具），都是现有通道。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.on('data', (d) => (s += d.toString('utf8')));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

function buildPrompt({ transcript, ledger, mode }) {
  const tasks = (ledger?.tasks || [])
    .map((t) => `- [${t.id}] 成员=${t.agent} 任务=${t.title} 状态=${t.status}${t.digest ? ` 摘要=${String(t.digest).slice(0, 60)}` : ''}`)
    .join('\n') || '（台账为空：当前没有记录在案的在办任务）';
  if (mode === 'conclusion') {
    return [
      '你是多智能体群聊的调度总结器。下面是一场成员讨论的发言记录和在办任务台账。',
      '收拢这场讨论：达成了什么结论、要不要改在办任务、新的活儿归谁。',
      '规则：只收拢讨论里明确说到的内容，不要替成员发明决定；没结论就如实说没结论。',
      '',
      '输出要求：只输出一行严格 JSON，不要解释、不要 markdown 代码块。格式：',
      '{"summary": "<两句话以内的小结>", "assignments": [{"agent": "<成员>", "task": "<任务一句话>"}]}',
      '没有明确分工时 assignments 为空数组。',
      '',
      '—— 在办任务台账 ——',
      tasks,
      '',
      '—— 讨论发言记录 ——',
      String(transcript || '').slice(-4000),
    ].join('\n');
  }
  return [
    '你是多智能体群聊的调度判定器。下面是一段成员间的讨论记录，以及各成员的在办任务台账。',
    '判断：这段讨论是否影响台账里的在办任务（会改需求、要求暂停、返工或重新分配就算影响）。',
    '规则：台账为空时，除非讨论明确在重新分配工作或推翻已有结论，否则判不影响。',
    '不确定时判不影响（宁可漏报，不要误报打断正常干活）。',
    '',
    '输出要求：只输出一行严格 JSON，不要解释、不要 markdown 代码块。格式：',
    '{"affected": <true|false>, "reason": "<一句话理由>", "impacts": [{"agent": "<成员>", "task": "<台账任务名>", "why": "<一句话>"}]}',
    '不影响时 impacts 为空数组。',
    '',
    '—— 在办任务台账 ——',
    tasks,
    '',
    '—— 讨论记录 ——',
    String(transcript || '').slice(-4000),
  ].join('\n');
}

function extractJson(text) {
  // qoderclicn 偶发夹带 CLI 状态行（任务：…｜运行中 等），先按行去噪再抽 JSON
  const cleaned = String(text)
    .split('\n')
    .filter((l) => !/^任务：.*｜/.test(l.trim()) && !/^当前进度：/.test(l.trim()) && !/^Shell cwd was reset/.test(l.trim()))
    .join('\n');
  const s = cleaned.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('输出里没有 JSON 对象');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!('affected' in obj)) obj.affected = null; // conclusion 模式没有 affected 字段
  if (!Array.isArray(obj.impacts)) obj.impacts = [];
  return obj;
}

async function runDsh(prompt) {
  const keyFile = path.join(HOME, '.dsh/openai-gateway/api-key');
  const apiKey = fs.readFileSync(keyFile, 'utf8').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('http://127.0.0.1:8326/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-account/deepseek-flash',
        messages: [
          { role: 'system', content: '你是调度判定器，只输出一行严格 JSON，不输出任何其他内容。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function runQoderOnce(prompt) {
  const QODER = path.join(HOME, '.qoder-cn/bin/qoderclicn/qoderclicn.exe');
  const env = { ...process.env };
  for (const k of ['QODER_AGENT_SDK_ENTRYPOINT', 'QODER_AGENT_SDK_VERSION', 'QODERCLI_RUNTIME_PACKAGING', 'QODER_SDK_AUTH_PAYLOAD_FILE']) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(QODER, [
      '-p', '--permission-mode', 'bypass_permissions',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers": {}}',
      '--tools', '', '--', prompt,
    ], { cwd: HOME, windowsHide: true, env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('qoderclicn 判定超时')); }, 90000);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = String(out).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (code !== 0 || !text) return reject(new Error(`qoderclicn 未作答（exit=${code}）${String(err).slice(0, 120)}`));
      resolve(text);
    });
  });
}

// GLM 直连：比 qoderclicn 一跳快一个数量级，判定/小结的 JSON 服从度也更稳
async function runGlm(prompt) {
  const apiKey = process.env.GLM_API_KEY || '';
  if (!apiKey) throw new Error('无 GLM_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [
          { role: 'system', content: '你是调度判定器，只输出一行严格 JSON，不输出任何其他内容。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

const input = JSON.parse(await readStdin() || '{}');
const prompt = buildPrompt(input);
let raw = '';
try {
  raw = await runDsh(prompt);
} catch (e1) {
  try {
    raw = await runGlm(prompt);
  } catch (e2) {
    try {
      raw = await runQoderOnce(prompt);
    } catch (e3) {
      console.error(`判定通道全失败：DSH=${String(e1?.message || e1).slice(0, 60)} / GLM=${String(e2?.message || e2).slice(0, 60)} / Qoder=${String(e3?.message || e3).slice(0, 60)}`);
      process.exit(1);
    }
  }
}
try {
  process.stdout.write(JSON.stringify(extractJson(raw)));
} catch (err) {
  console.error(`判定输出不可解析：${String(err?.message || err)}；原始=${String(raw).slice(0, 200)}`);
  process.exit(1);
}
