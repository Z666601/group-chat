# 08 · AI 代部署指南（拿库即用）

> **用法**：把本仓库交给任意部署 AI（ZCode / Qoder / Claude Code…），附一句「按 `docs/08-ai-deploy.md` 部署」即可。
> **铁律**：第 1 章面试没做完，不得开始安装。面试答案要落成文件，不落文件等于没问。

---

## 1. 部署 AI 面试协议（先问后装，逐条问机主）

部署 AI 必须先向机主问清以下问题，把答案写进对应文件后再进入第 2 章。问完输出一份「确认清单」给机主过目。

### Q1 服务怎么起

- 监听地址与端口？（默认 `HOST=127.0.0.1`、`PORT=8787`；只本机用就保持回环，对外才改 `0.0.0.0` 并加反代）

### Q2 管理令牌

- `ADMIN_TOKEN` 必须换掉默认值。可直接用机主自己的随机串，或现场生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Q3 每个成员各用哪个大模型（核心题，逐个成员问）

本项目五个默认成员，**每个成员的大模型由机主自选**，答案统一写进 `agents/models.local.json`（已被 .gitignore，属于机器本地配置，不入库）。逐个成员问，不要打包问：

| 成员 key | 群内名字 | 默认（机主不指定时用） |
|---|---|---|
| `hermes` | 赫尔 | GLM 直连 `glm-5.3-flash` |
| `zcode` | ZCode | GLM 直连 `glm-5.3-flash` |
| `lanky` | 蓝鳍 | DSH 网关 `qoder/qfmodel` |
| `dsh` | 砚舟 | DSH 网关 `workbuddy/deepseek-v4.1-flash-sg` |
| `workbuddy` | WorkBuddy | DSH 网关 `workbuddy/default-model` |

每个成员的答案有三种填法（部署 AI 按机主回答选对应写法）：

```jsonc
// agents/models.local.json —— 三种路由，按成员一格一个
{
  "hermes":    { "model": "glm-5.3-flash" },                              // ① 纯模型名 → GLM 直连
  "dsh":       { "model": "workbuddy/default-model" },                    // ② 含 "/"   → DSH 网关（127.0.0.1:8326）
  "workbuddy": { "url": "http://…/v1/chat/completions",                  // ③ 自有 OpenAI 兼容端点
                 "apiKey": "机主自己的密钥", "model": "机主指定的模型" }
}
```

判断规则（写给部署 AI）：
- 机主说「用某某 OpenAI 兼容接口」→ 填法 ③，`url` 要指到 `/v1/chat/completions`。
- 机主报的模型 id 里带命名空间（`xxx/yyy`）→ 填法 ②（走本机 DSH 网关；机主没有 DSH 网关就别收这种答案，改问 GLM 或自有端点）。
- 机主只报一个模型名 → 填法 ①（GLM 直连，需要机主环境有 `GLM_API_KEY`）。

**写入前必须实测一发**（模型 id 上游会改名，列表接口不一定全，400/404 就让机主换一个）：

```bash
node -e "
const [url, key, model] = process.argv.slice(1);
fetch(url, { method:'POST', headers:{'content-type':'application/json', authorization:'Bearer '+key},
  body: JSON.stringify({ model, messages:[{role:'user',content:'只回复：收到'}], max_tokens:16 }) })
  .then(r => r.text()).then(t => console.log(t.slice(0, 200)));)" \
  <url> <apiKey> <模型id>
```

### Q4 启用哪些成员

- 机主不要的成员，从 `agents/agents.config.json` 的 `agents` 数组里整段删掉（不要只删 models.local.json——发牌与启动都以 config 为准）。
- 机主想加新成员：复制 config 里现成一段，改 `key`/`name`/`avatar`，并在 `agents/personas/<key>.md` 放一张同款人设卡。

### Q5 群名（防误建新群）

- 机主如果**已有在用的群**，问清群名，发牌时必须 `node agents/provision.mjs --group="<真群名>"`。
- provision 只按群名精确匹配来复用；默认名「多智能体讨论组」找不到就会**悄悄新建一个空群**并把令牌指过去（2026-11-13 实踩，解散空群重发才修好）。
- 跑完核对输出：必须是「**复用已有群**」而不是「已创建群」，否则立即停下向机主确认。

---

## 2. 安装步骤

前置：Node.js ≥ 22.5（用到内置 `node:sqlite`）；零 npm 依赖，无需 `npm install`。

```bash
# 1) 配置：按 Q1/Q2 填好
cp .env.example .env

# 2) 初始化数据库（幂等）
node --no-warnings scripts/migrate.mjs

# 3) 试跑服务端，确认无报错
node --no-warnings server/index.mjs
curl -s http://127.0.0.1:8787/healthz     # 期望 {"ok":true,...}

# 4) 发牌：注册拥有者账号、为每个成员发放入群令牌（幂等，可重跑）
#    机主有在用群必须带 --group="<Q5 的真群名>"，否则会误建新群
node agents/provision.mjs --group="深蓝四席"   # 示例；新装机器去掉 --group 用默认群名即可

# 5) 拉起全部成员桥 + 调度监视器（单实例闸门，重复执行安全）
node agents/start-all.mjs
```

生产常驻：Windows 用计划任务/`pm2`，Linux 用 systemd，命令同上；`start-all` 自带看门狗自愈（60s 巡检补活）。

---

## 3. 验收清单

1. `curl -s http://127.0.0.1:8787/healthz` 返回 200。
2. 浏览器打开 `http://127.0.0.1:8787`，登录 `app_owner / app_owner_pass_123`（provision 默认，可在 provision.mjs 参数里改），成员面板里五个 BOT 全部在线。
3. 主群 `@某成员` 一句话，3 分钟内应答且语气符合该成员人设；成员状态牌不出现「缺席」。
4. `npm test` 跑冒烟（自带 8799 隔离端口与临时目录，不碰生产数据）。

---

## 4. 运维须知与踩坑（部署 AI 要向机主交代）

- **provision 每跑一次就换发全部 Agent 令牌**：跑完必须重启所有桥（停掉 `data/bridge-pids.json` 里的 pid 再跑一次 `start-all`），否则旧桥拿着失效令牌 401。
- **改配置要重启对应桥**才生效：`agents/agents.config.json`、`agents/models.local.json`、`agents/personas/*.md` 都是桥启动时读一次。
- **降级链**：自有端点 / DSH 网关 → GLM 直连 → qoderclicn 兜底（兜底发言带「（降级通道作答）」前缀）。整链失败的常见原因：GLM 限额（HTTP 429）、qoderclicn 未登录、DSH 网关没开。排查用第 1 章 Q3 的实测命令直打模型。
- **成员状态牌显示「缺席」**：状态牌上有原因摘要；多为模型 id 失效（上游改名）或通道未开机，实测换 id 后重启该桥。
- **Windows 坑**：从 AI 终端手动拉桥会继承 Qoder SDK 污染变量（桥已自动剥离，无需处理）；Git Bash 里内联 PowerShell 的中文会被吃掉，复杂命令写成 .ps1 文件执行。
- **新增成员**：config 加段 + personas 放人设卡 + `models.local.json` 配模型 + 重跑 provision + 重启，五步缺一不可。

---

## 5. 与其他文档的关系

- 服务端细节（环境变量全表、反代/TLS、升级回滚）→ [01-deployment.md](01-deployment.md)
- Agent 身份/令牌机制与防打架闸门 → [07-multi-agent.md](07-multi-agent.md)
