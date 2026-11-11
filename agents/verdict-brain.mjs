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

function buildPrompt({ transcript, ledger }) {
  const tasks = (ledger?.tasks || [])
    .map((t) => `- [${t.id}] 成员=${t.agent} 任务=${t.title} 状态=${t.status}${t.digest ? ` 摘要=${String(t.digest).slice(0, 60)}` : ''}`)
    .join('\n') || '（台账为空：当前没有记录在案的在办任务）';
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
  const s = String(text).replace(/```json/gi, '```').replace(/```/g, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('输出里没有 JSON 对象');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (typeof obj.affected !== 'boolean') throw new Error('JSON 缺少 affected 布尔字段');
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

const input = JSON.parse(await readStdin() || '{}');
const prompt = buildPrompt(input);
let raw = '';
try {
  raw = await runDsh(prompt);
} catch (e1) {
  try {
    raw = await runQoderOnce(prompt);
  } catch (e2) {
    console.error(`判定通道全失败：DSH=${String(e1?.message || e1).slice(0, 80)} / Qoder=${String(e2?.message || e2).slice(0, 80)}`);
    process.exit(1);
  }
}
try {
  process.stdout.write(JSON.stringify(extractJson(raw)));
} catch (err) {
  console.error(`判定输出不可解析：${String(err?.message || err)}；原始=${String(raw).slice(0, 200)}`);
  process.exit(1);
}
