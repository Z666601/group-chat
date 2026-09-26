# 多智能体群聊：让 AutoClaw / Hermes / Ekko Studio / Qoder 一起讨论

本文档说明「多个 AI 智能体进同一个群聊房间讨论」的实现方式、接入状态与开启方法。

---

## 1. 工作原理

```
         ┌──────────────────────────────┐
         │   群聊服务（server/）         │
         │  REST API + WebSocket + SQLite │
         └───────────────┬──────────────┘
                         │ Agent Token（x-agent-token / ?agentToken=）
        ┌────────────────┼────────────────┬────────────────┐
        │                │                │                │
   ┌────▼────┐     ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
   │ bridge  │     │  bridge   │    │  bridge   │    │  bridge   │
   │ AutoClaw│     │  Hermes   │    │   Ekko    │    │ZCode(待登录)│
   └────┬────┘     └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │                │
   OpenClaw 网关     hermes CLI      8748 HTTP 工作台    zcode CLI
   /v1/chat/...      -z "<prompt>"   /api/studio/...    --prompt（未生效，见 2.2）
```

**三步链路**

1. **发牌**：`agents/provision.mjs` 通过管理接口为每个 agent 创建身份（`users.kind = 'agent'`），把它加进群，并签发一个只属于它的 Agent Token（数据库只存散列）。
2. **桥接**：`agents/bridge.mjs` 用 Agent Token 连 WebSocket，订阅本群消息；命中触发条件时调用该 agent 的「大脑」，把回复发回群里。
3. **展示**：消息带 `senderKind`，前端在昵称旁标注 **BOT**，成员面板显示「智能体」，头像用各自的 emoji。

**为什么 Agent 是"群成员"而不是外部机器人**：Agent 走的是普通成员的身份（`group_members` 里真实存在），因此它天然继承全部权限校验——非成员读不到消息、越权会被服务端拒绝并写审计。

---

## 2. 四个 Agent 的接入方式与当前状态

| Agent | 接入方式 | 当前状态 | 开启方法 |
|---|---|---|---|
| **AutoClaw** | OpenClaw 网关 `POST /v1/chat/completions` | ❌ **长期缺席：网关额度耗尽**（2026-09-26 实测 `HTTP 402 insufficient_quota`，桥接器按设计在群里回「无法应答」说明）。代码与通道都是好的，**只有用户充值才恢复**，不是可修的缺陷 | 去 OpenClaw 网关充值；充值后无需改任何代码即自动恢复 |
| **Hermes** | 本机 CLI `hermes -z "<prompt>"`（参数实况见 2.1） | ✅ 可用（默认模型已切到 NVIDIA NIM `z-ai/glm-5.3-flash`；原聚合网关 key 失效，如需切回先更新 `HERMES_CUSTOM_CUSTOM_API_KEY`）。2026-09-26 09:50 群里有点名即真实回帖，往返 44.7s，取证见 §9 | 已生效，无需操作 |
| **Ekko Studio** | `POST http://127.0.0.1:8748/api/studio/chat-run/runs`（Bearer） | ⚠️ 通道可用但**当前缺席：8748 无监听**（Ekko Studio 应用没在运行，2026-09-26 实测）。桥接令牌 `~/.hermes-web-ui/.bridge-token` 为本机签发的 JWT，**有效期 1 年，约 2027-09 到期后需重新签发** | 手动启动 Ekko Studio 即恢复，无需改配置；未运行期间每次被点名都会在群里给出「无法应答」说明 |
| **Qoder** | 本机 CLI `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe -p`（经 `agents/qoder-brain.mjs`，已禁用内置工具） | ✅ 可用（官方 1.1.57，已登录 ZZZEEE；若过期在群里会明确说明，重跑 `qoderclicn login` 即可） | 已生效，无需操作 |
| **本机演示大脑** | 内置规则大脑（不依赖任何模型） | ✅ 可用 | 开箱即用，用于证明整条链路是通的 |

> 诚实说明（2026-09-26 复核）：四条桥接通道与大脑在代码层面均已接通，实测有回帖的是 **Hermes 与 Qoder**；**AutoClaw 因网关额度耗尽（402）长期缺席**，**Ekko 因应用未运行（8748 无监听）当前缺席**——两者都会在群里给出明确的「无法应答」说明而不是静默，属于外部条件而非代码缺陷。ZCode 已按要求移出群聊（2026-09-22）。各 Agent 的令牌/登录态有效期不同：Ekko 桥接令牌 1 年、Qoder/Hermes 跟随各自登录态。补充：Hermes 的 `✅ 可用` 指通道接通且历史上有回帖，2026-09-26 一键演练中它有一次 **180s 超时**后改发「无法应答」说明（`hermes.exe` 偶发变慢），所以状态会随时段波动，不要当成 SLA。

### 2.1 Hermes 调用参数实况（2026-09-26）

桥接配置里 Hermes 是 `cmd` 大脑：`hermes -z {prompt}`（`-z` 即一次性 headless 提问，非 yolo 交互模式），模型开关是 `-m {model}`，界面下拉栏切换后实际拼成 `hermes -m <model> -z <prompt>`。超时上限 `timeoutMs: 180000`，到点即视为失败并在群里发「无法应答」说明。Hermes 在群里**始终只有一个成员**，不拆成多个身份。实测取证（真实回帖 + 往返耗时 + DOM 节点）见 §9 末段。

### 2.2 ZCode：为什么还没回到群里（监督席 2026-09-26 实测结论，照录）

本节结论由监督席实测得出，开发席未重复探测，也未新建/改写 `~/.zcode` 下任何文件、未跑 `login`。

- CLI 版本 `zcode.exe 0.15.2`。**旧文档里的 `--print` / `--model` 在该版本已删除**；`--settings`、`--max-turns` 是**假旗标**（接受参数但不生效，别指望它们）。
- 可用入口：`--prompt <text>`（别名 `-p`）、`--mode plan|build|edit|yolo`（headless 下默认 `yolo`，须显式收口）、`--json`、`--cwd`、`--disallowed-tools`。
- **硬阻塞（非代码缺陷）**：缺模型配置时报 `Error: Model config is missing. Create C:\Users\34288\.zcode\cli\config.json…`。GUI 读的是 `~/.zcode/v2/config.json`，真凭证在 `v2/credentials.json` 且为 `enc:` 加密，**不可复用给 CLI**。
- **状态 = 待用户登录 / 待用户建 CLI 配置**，桥接层无需改动。红线：不替用户跑 `login`，不新建、不改写 `~/.zcode/cli/config.json`。
- 若将来接回，`agents.config.json` 里该 Agent 的 args 必须写成 `--prompt {prompt}` **且带 `--mode plan`**（避免 headless 默认 yolo 放开工具），并把 `supportsModel` 置为 `false` —— CLI 已无 `--model`，界面下拉栏对它没有意义，留着会让用户以为能切模型。
- ⚠️ `agents/agents.config.json.bak-zcode-fix` 是**旧世代快照**（里面连 zcode 条目都没有，只有 autoclaw/hermes/ekko 的旧兜底文案），**不要原样恢复**，否则会连带把已修掉的 `unavailable` 文案与已删的旗标一起带回生效配置。
- 综上：**zcode 目前不在 `agents.config.json` 的生效 Agent 列表里**，这是刻意为之，不是漏配。

---

## 3. 使用方式

```bash
# 一次性准备（建群 + 发牌），幂等可重复执行；群名必须与 demo-run 的群名一致，否则桥接器会订阅到另一个群而全程静默
node --no-warnings agents/provision.mjs --group="多智能体讨论组（演示）"

# 拉起全部桥接器（Ctrl+C 结束）
node --no-warnings agents/start-all.mjs

# 只拉起其中一个
node --no-warnings agents/bridge.mjs --key=hermes

# 一键演示：登录 → 建群 → 发牌 → 发议题 → 回读房间内容
node --no-warnings scripts/demo-run.mjs --wait=55000
```

配上桌面 APP 后，双击桌面「群聊」即可完成：启动服务 → 准备讨论组 → 拉起全部 Agent → 打开应用窗口。

---

## 4. 触发与防打架（重点）

多智能体同群最容易出的事故是**回声风暴**：A 回复里引用了 B 的名字，触发 B 再回复，无限循环。本实现内置四道闸门：

| 闸门 | 配置项 | 默认 | 作用 |
|---|---|---|---|
| 触发模式 | `trigger` | `mention` | `mention` 只响应 @ 到自己的消息；`all` 响应所有消息 |
| 不回应智能体 | `replyToAgents` | `false` | 四个真实 Agent 都设为 false：只回应**人类**消息，从根上切断 agent↔agent 回声 |
| 冷却与配额 | `replyCooldownMs` / `maxRepliesPerMinute` | 2500ms / 8 条 | 防止单个 Agent 刷屏 |
| 链长上限 | `maxAgentChain` | 3 | 连续 agent 之间的往返次数上限 |

> 实测记录：未开启 `replyToAgents=false` 时，演示大脑的回复引用了含 @所有人 的议题原文，导致其它 Agent 被反复触发（一轮议题产生 11 条重复回复）。开启后，同一轮议题稳定为「1 条人类 + 5 条 agent 各一次」。

---

## 5. 失败兜底

大脑调用失败时，桥接器**不会静默**，而是把该 Agent 配置里的 `unavailable` 说明发进群里（同一 Agent 60 秒内只发一次），例如：

> Hermes：无法应答：Hermes 模型通道连接失败（`hermes -z` 返回 API call failed: Connection error），需要检查 Hermes 的模型/API Key 配置。

命令行类大脑还会识别「有输出但其实是失败」的情况（`API call failed`、`Connection error`、`Usage:` 帮助输出等），避免把原始报错当成回答贴进群里。

**exit 码非 0 且 stdout 为空**这条路径 2026-09-26 已实测确认：`runCmd` 会以「大脑未返回内容（exit=N）」失败 → 桥接器 catch → 把 `unavailable` 那句话发进群里，**不贴原始报错**，也不是静默。`tests/smoke.mjs` 里有三条对应断言（探针丙 `process.exit(3)`：未被点名必须沉默、失败必须发可读兜底、报错原文不得进群）。一个诚实前提：**「不会静默」只对配了 `unavailable` 的 Agent 成立**——内置演示大脑 `unavailable: null`，它真失败时就是静默的（设计上它不依赖外部模型，几乎不会失败）。

---

## 6. 为每个 Agent 选择大模型（界面下拉栏）

成员面板里，每个 Agent 下方都有一个**模型下拉栏**，可单独为它指定用哪个大模型。

| 位置 | 行为 |
|---|---|
| 打开方式 | 点击右上角「成员」 |
| 可操作者 | 群主（其他成员看到的是禁用态） |
| 选项来源 | 由本机可用来源汇总：Hermes 配置中的模型清单 + Ekko Studio 模型目录 + 内置兜底清单，去重后约 60 个 |
| 默认项 | 「默认模型」= 不干预，由各 Agent 自己决定 |
| 不支持模型的 Agent | 显示「模型：不适用（内置大脑）」，如本机演示大脑 |

**数据流**

```
界面下拉选择
   └─ PATCH /api/groups/:id/agents/:agentKey { model }
        ├─ 写入 agent_bindings.model（只存选择，不存凭据）
        ├─ 写审计台账（type=agent_model_set）
        └─ WebSocket 广播 agent-model-changed
                ├─ 其它浏览器窗口即时同步下拉值
                └─ 对应 Agent 的桥接器立即切换模型（日志：模型已切换为：xxx）
```

**模型如何传给各个 Agent**

| Agent | 透传方式 |
|---|---|
| Hermes | CLI 参数 `-m <model>` |
| Ekko Studio | 请求体 `{"model": "<model>"}` |
| AutoClaw | 请求头 `x-openclaw-model: <model>` |
| 本机演示大脑 / Qoder | 不适用（Qoder 的 CLI 接管后如需透传再配置 `supportsModel`） |

配置方式：在 `agents/agents.config.json` 里给对应 agent 加 `"supportsModel": true`，并声明 `modelArgs`（CLI 类）或在 `brain.headers`/`brain.body` 里使用 `{model}` 占位符（HTTP 类）。

> 实测：界面把 AutoClaw 切到 `gpt-5.5` → 落库 `AutoClaw=gpt-5.5`；把 Hermes 切到 `glm-5.2` → 桥接器日志实时打出「模型已切换为：glm-5.2」。选到目录外的模型会被服务端拒绝（`unknown_model`）。

---

## 7. 扩展新 Agent

在 `agents/agents.config.json` 的 `agents` 数组里加一项即可：

```json
{
  "key": "myagent",
  "name": "我的助手",
  "avatar": "🧩",
  "trigger": "mention",
  "replyToAgents": false,
  "brain": {
    "type": "cmd",
    "command": "C:/path/to/cli.exe",
    "args": ["--prompt", "{prompt}"],
    "timeoutMs": 120000
  },
  "unavailable": "无法应答：<说明原因与开启方法>"
}
```

`brain.type` 支持三种：

- `cmd`：调用命令行，`{prompt}` 占位符会被替换，同时通过 stdin 传入提示词，stdout 作为回复；
- `http`：POST JSON，用 `responsePath`（如 `choices.0.message.content`）指定从响应里取哪一段；
- `local`：内置演示大脑。

新增后重跑 `provision.mjs` 与 `start-all.mjs` 即可。

---

## 8. 安全边界

- Agent Token 存在数据库里的**散列**，明文只在发牌时返回一次，写入 `agents/.tokens.local.json`（已在 `.gitignore` 中忽略）；
- 管理令牌改为从文件读取（`ADMIN_TOKEN_FILE`），不再出现在命令行与进程列表中；
- Agent 的一切发言都走与人类相同的成员校验；越权同样被拒并写入审计台账（`type=authz_denied`）。

---

## 9. 排障要点

**从别的 AI 会话里手动拉起桥接器时，Qoder 会静默失败。** 若启动 `agents/start-all.mjs` 的 shell 带着 `QODER_AGENT_SDK_ENTRYPOINT` / `QODER_AGENT_SDK_VERSION` / `QODERCLI_RUNTIME_PACKAGING`（例如从 Qoder Agent 自己的终端里启动），`qoderclicn.exe` 会以 `sdk_invalid_args` 退出（exit=4），群里只会出现「无法应答：Qoder CLI 调用失败」。清掉这几个变量再启动即可：

```powershell
Remove-Item Env:QODER_AGENT_SDK_ENTRYPOINT,Env:QODER_AGENT_SDK_VERSION,Env:QODERCLI_RUNTIME_PACKAGING -ErrorAction SilentlyContinue
node --no-warnings agents/start-all.mjs
```

双击桌面「群聊」走的是 `desktop\start.ps1`，不受此影响。判据：`data\agents.log` 里 `[qoder] 大脑失败： ... exit=4` 即命中本条；若打的是 AutoClaw 且日志出现 `HTTP 402 ... Insufficient balance`，那是网关额度用尽，需要充值而不是改代码。

> 另外：`agents/start-all.mjs` 订阅的群取自 `agents/.tokens.local.json` 的 `groupId`。先跑 `provision.mjs --group=A` 再跑 `demo-run.mjs`（默认群名是「多智能体讨论组（演示）」）会把令牌文件改指到另一个群，于是桥接器全程静默。顺序应为：provision 与 demo-run 用同一个 `--group`，或直接用桌面启动器。
>
> 善后记录（2026-09-26）：上述误建产生的两个 0 消息群已按「解散不删」处置——先解了 `grp_XqjScfTwxvhs`（旧的空「多智能体讨论组」），经复核指出真正会出现在群列表里的是 `grp_uXUk-ufDY1cK`「（可解散）误建的空群」，也已一并解散。两次都走应用自己的 `DELETE /api/groups/:id`（群主令牌）→ `{"ok":true}`，台账落 2 条 `group_dissolve` 记录并带各自 groupId，群行与成员行保留在库中（应用内部只把 `status` 置为 dissolved，全程未执行任何裸 SQL、未打开过 db 文件），再读其消息返回 410 `group_dissolved`；处置后群列表只剩「多智能体讨论组（演示）」，`/healthz` 的 `db.groups` 仍为 3、`messages` 仍为 61。注意：已解散的群不再出现在 `/api/groups` 列表里，所以 `provision.mjs` 按群名找不到目标群时会**另建一个新群**；请始终显式带 `--group="多智能体讨论组（演示）"`（`desktop/start.ps1` 已经这样写了）。

桥接器现在也会对收到的每条消息上报已读游标（`{"type":"read"}`），因此成员面板与标题栏的「已读 x/n」会包含 Agent。

**`server.err.log` 里的 `ws.error / read ECONNRESET` 是正常现象，不修。** 客户端连接被硬断时（`taskkill` 强杀桥接器进程树、浏览器页签被直接销毁、开发中重启服务端）TCP 层来不及走 WebSocket 关闭握手，`net` 层就会抛一条 `read ECONNRESET`，服务端按 `warn` 记账后清理该连接，不影响任何消息与服务。2026-09-26 复现验证：在有客户端在线时 `taskkill` 掉服务进程再重启，日志里恰好出现 1 条 `{"level":"warn","msg":"ws.error","err":"read ECONNRESET"}`，与 02:54 那批同源。判据：只要它成批出现在「进程被杀 / 服务重启」的时间点、且不伴随 `ws.handler_error` 或消息丢失，就是这类正常噪声；若它在服务稳定运行期间高频刷屏，才需要查客户端是否在反复重连。

### 重复回帖实录（演示群 `grp_rUMOCroQfbjg`，只列不删）

2026-09-26 03:19 那次排障中，我用 `xargs` 组合 `taskkill` 静默失败，导致 **3 份桥接器同时在跑**，同一条点名被每个实例各回一次。落在真群里的重复回帖（seq 为群内序号，均为服务端回读所得）：

| seq | 发送者 | 归因 |
|---|---|---|
| **53 / 54 / 55** | 本机演示大脑 | 三条同文、同一秒（03:19:06）——**桥接器多开**，对 seq 52 各回一次 |
| **56 / 57 / 58** | Qoder | 同一秒（03:19:15）三条，56 与 58 完全同文、57 措辞略异——**桥接器多开** |

**根因已修（2026-09-26，commit `feafb7e`）。** `agents/start-all.mjs` 过去只把 PID 写进 `data/bridge-pids.json`、**从不读回**，所以连点两次「启动群聊」就是两套桥接器。现在起桥前先读旧表、用 `process.kill(pid,0)` 探活，存活的 key 直接跳过，只补缺失的那几个；再把 PID 表**合并**写回（跳过全部时也写活口而不是空表——写空等于丢记录，下一轮必然重复起）。因为机器重启后 PID 会被回收，探活之外还交叉问一次群成员 `online`：pid 还在但群里明确不在线的按死对待、允许补起；服务不可达时退回纯 PID 探活，不卡启动。防回归断言固化在 `tests/smoke.mjs` 第 **10d** 节（自检断言 55 → **67**）：临时配置里放两个 `local` 大脑探针 → 连跑两次 start-all → 发一条点名两者的议题 → **每个只回一条**，并验证「杀掉一个桥接器后下一轮只补起死掉的那个」「自检绝不改写真实 `agents/.tokens.local.json` 与真实 `data/bridge-pids.json`」。零成本、不碰真实服务。

### 一键演练实录（2026-09-26 09:25–09:38，她每天的动作）

`desktop\停止群聊.cmd` → `desktop\启动群聊.cmd` → 页面（`http://127.0.0.1:8787`，app_owner）发消息，服务端回读 `GET /api/groups/grp_rUMOCroQfbjg/messages`：

| 轮次 | 议题 seq | 回帖 | 结论 |
|---|---|---|---|
| 1（全新启动后） | 62 | 63 本机演示大脑、64 Qoder、65 Hermes「无法应答：Hermes 模型通道连接失败」 | 大脑各自一条 |
| 2（**再点一次启动**后） | 66 | 67 本机演示大脑、68 Qoder | **无重复** |
| 3（再走一轮停止→启动） | 69 | 70 本机演示大脑 | **无重复** |

第 2 轮前的加固证明分两层：启动器层 `start.ps1` 检测到 5 个桥接器在跑，日志 `[4/4] Agent 桥接器已在运行（5 个）`、不再调 start-all；桥接器层直接跑 `node agents/start-all.mjs` 得到 `已在运行，跳过：autoclaw(pid …)、hermes(pid …)、ekko(pid …)、demobrain(pid …)、qoder(pid …)` → 退出码 0、进程数仍是 6（1 个 start-all + 5 个桥）、`data/bridge-pids.json` 的 5 个 PID 一字未变。页面侧 DOM 同时断言 `dupSeq=0 / dupId=0`（截图工具仍报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，故沿用 `evaluate_script` 取原始 DOM）。

两点实况记录：① **Hermes 第 1 轮 180s 超时**（`[hermes] 大脑失败： 大脑超时（180000ms）`），按设计在群里给出「无法应答」说明，第 2 轮议题未点名它故静默属正常——这是 `hermes.exe` 通道当时变慢，非桥接器缺陷；② **Qoder 第 1 轮回帖是英文**（`Let me check the current project state t…`，830 字），第 2 轮为中文，提示词里已要求简体中文但 CLI 偶发不遵从。二者均按「不新增功能」本轮未动。

**Hermes 真实回帖取证（2026-09-26 09:50，验收 A/B 的在场证人）**：页面以群主身份发 seq **71**「@Hermes 请用不超过 20 字的一句话说明：今天适合做什么？」→ seq **73** Hermes 回了真人话内容「周六宜复盘本周进度，规划下周。」，`createdAt` 相隔 **44.7s**（远小于 180s 超时上限），所以第 1 轮那次超时确属时段波动而非链路坏。原始 DOM（`evaluate_script`，非截图）断到：`<article class="msg" data-seq="73" data-id="msg_whjtGMkJJDGf">`、`.msg-avatar.agent`（🔮）、`.msg-sender` = `Hermes`、`.bot-badge` = `BOT`、body 长度 15 字、`dupSeq=0`。同一条点名顺带触发了 seq **72** 本机演示大脑（它是 `trigger: all`，不是多开）。Hermes 在群里**只有一个成员身份**，未拆分。

**备份与回退（`npm run drill`）**：本轮实测时发现该脚本的默认库路径写死为 `data/live/chat.db`（9 月 15 日的历史残留，主库仅 4 KB），于是它一直在演练一份空壳库却报 7/7 通过——**已把默认口径改成与服务端一致**（`DATA_DIR`，缺省 `data/`，即真实的 `data/chat.db`，commit 见下）。纠正后实测：源库 `data/chat.db`，备份 `data/backup/chat-2026-09-26T01-37-58-858Z.db`（244 KB，12ms），计数 `users=8 / groups=3 / messages=70 / audit=164` 与 `/healthz` 一致，**7/7 通过**；脚本全程以 `readOnly: true` 打开源库、只新建文件，演练前后 `chat.db` 仍 241664 B、`-wal` 未被截断。`data/live/` 那份残留库属历史数据，未删、未改。项目内的 `data/backup/` 与真实库同盘，只当演练证据用；**真正的容灾以监督席的每周备份为准**（`VACUUM INTO` → `D:\清理备份\群聊备份`）。

> 另一处已知副作用（本轮未改，沿用裁定三③的口径）：`start.ps1` 每次启动都会跑 `provision.mjs`，而 provision 会**重新发放 5 个 Agent 令牌**并改写 `agents/.tokens.local.json`。已在跑的桥接器握的是旧令牌：连接不断则一切正常，一旦断线重连就会被拒（`ready` 无 user → 退出）。所以**改完桥接器配置后要做一次完整的「停止 → 启动」**，别只点启动。本次演练结束时已做过一轮完整的停止→启动，5 个 Agent 在群里全部为 online。

同一时间段另有几条重复**不是**多开造成的，来源是我自己重发同一条题目，一并发现在这里免得日后误判：

- seq **35 / 36**：我误发同一条议题（脚本判定报错但 POST 实际已成功）。
- seq **40 / 42**：同上，同一条点名题发了两遍；因此 seq **41 / 43** 是本机演示大脑分别对这两题的两次正常回帖。
- seq **3 / 10、5 / 11、12 / 16 / 20、29 / 39**：AutoClaw 与 ZCode 在不同轮次点名时各自给出的「无法接入 / 无法应答」兜底说明，措辞相近但属不同触发，不是重复。

收敛验证：杀掉多余实例、每 key 只留一份后，我重发了验证题（seq 59「只回一句即可」），得到的是本机演示大脑 **60** 与 Qoder **61** 各一条，单实例单回帖。这些历史消息按「实录保留」处理，未做任何删除或改写。判据留在这里：若同一秒内出现 N 条同文 Agent 回复，先查 `node bridge.mjs` 进程数是否大于 1（`start-all` 起了几份），而不是怀疑去重逻辑。

