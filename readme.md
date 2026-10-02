# 群聊（auto-group-chat）

自建 Web 群聊：**建群 / 邀请成员 / 实时收发 / 历史回溯 / 断线补齐不丢不重 / 引用回复 / 历史搜索 / 智能体状态牌 / 成员与权限管理 / 审计台账 / 可观测性**。

- 零第三方依赖：只用 Node.js 内置模块（`node:http`、`node:crypto`、`node:sqlite`）与一段自实现的 RFC6455 WebSocket 服务端。
- 前端为单页原生 JS + CSS，系统字体、零装饰（Information Architects 风格），桌面与移动自适应。
- 数据落在 SQLite（WAL 模式），带审计台账与指标接口。

---

## 桌面 APP（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File desktop\安装桌面快捷方式.ps1
```

执行后桌面上会出现：

- **「群聊」快捷方式**（自定义图标，指向一键启动器）
- **「群聊」文件夹**（含 `启动群聊.cmd` / `停止群聊.cmd` / `使用说明.txt`）

双击「群聊」即完成：启动服务 → 准备多智能体讨论组 → 拉起全部 Agent → 打开独立应用窗口（Chrome `--app` 模式，无浏览器工具栏）。默认账号 `app_owner` / `app_owner_pass_123`。

---

## 多智能体讨论

群聊支持把外部 AI 智能体（AutoClaw / Hermes / Ekko Studio / ZCode / 自建）作为**真实的群成员**拉进同一个房间讨论：

```bash
node agents/provision.mjs --group="多智能体讨论组（演示）"   # 建群 + 为每个 Agent 发放入群令牌（幂等）
node agents/start-all.mjs        # 拉起全部 Agent 桥接器
node scripts/demo-run.mjs        # 一键演示：发议题并回读房间内容
```

- 桥接器 `agents/bridge.mjs` 支持可插拔大脑（`cmd` / `http` / `local`）
- **成员面板可为每个 Agent 单独选择大模型**（下拉栏，选项来自本机模型目录，切换后经 WebSocket 即时下发给对应 Agent）
- 内置四道防打架闸门（触发模式、是否回应智能体、冷却配额、链长上限），实测修复过一轮「回声风暴」
- 大脑不可用时会在群里明确说明原因，不静默、不贴原始报错
- **各 Agent 的接入条件与开启方法见 [多智能体文档](docs/07-multi-agent.md)**

---

## 一键启动

**前置条件**：Node.js ≥ 22.5（用到内置 `node:sqlite`）。无需 `npm install`。

```bash
# Linux / macOS
bash scripts/start-dev.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

# 或手动
cp .env.example .env        # 按需修改
node --no-warnings scripts/migrate.mjs
node --no-warnings server/index.mjs
```

启动后打开 <http://127.0.0.1:8787>。首次使用先「注册」两个账号，用其中一个建群，另一个凭邀请码加入，即可验证实时收发。

---

## 目录结构

```
group-chat/
├─ server/            后端与实时通道
│  ├─ index.mjs       入口：HTTP 服务、静态资源、WebSocket 挂载、定时维护
│  ├─ http.mjs        REST 路由与鉴权/权限判定
│  ├─ ws.mjs          RFC6455 WebSocket 服务端（握手/帧解析/分片/心跳）
│  ├─ hub.mjs         实时中枢：订阅、广播、断线补齐、在场、限流、落库
│  ├─ auth.mjs        口令散列（scrypt）、会话令牌、Cookie、权限校验
│  ├─ db.mjs          数据访问层（SQLite）+ 领域查询
│  └─ util.mjs        日志/指标/限流/HTTP 辅助
├─ web/               前端（零构建）
│  ├─ index.html      页面骨架（登录、会话列表、消息流、成员面板）
│  ├─ app.js          单页应用：API、实时通道、重连补齐、消息状态机
│  └─ styles.css      样式（含响应式与模态框）
├─ db/schema.sql      建表与索引（幂等）
├─ scripts/           migrate.mjs、start-dev.ps1、start-dev.sh
├─ tests/
│  ├─ smoke.mjs       端到端自检（43 项断言）
│  └─ loadtest.mjs    容量压测（默认 500 连接）
└─ docs/              部署 / 验收 / 异常路径 / 可观测 / 回滚 / 交接
```

---

## 核心机制

**实时与补齐**：每条消息在群内有一个单调递增的 `seq`。客户端订阅时上报本地最大 `seq`，服务端把 `seq` 之后的消息按序补发，再返回 `subscribed`。因此断线期间的消息不会丢、也不会重复（客户端按 `seq` 去重）。

**发送状态机**：发送方先本地渲染「发送中」，服务端落库后回 `ack`（含 `messageId`、`seq`），客户端转为「已发送」；8 秒无 `ack` 则标记「发送失败」并提供「重试」。实时通道不可用时自动降级走 REST。

**幂等**：客户端为每条消息生成 `clientMsgId`。服务端对 `(群, 发送者, clientMsgId)` 建唯一索引，重复提交直接回放既有消息，不会产生重复记录。

**权限**：未登录 → 401；非群成员读取/订阅/发送 → 403 并写入审计台账；仅群主可改名、移除成员、解散群；普通成员可邀请、退群。全部在服务端判定，前端隐藏入口只是体验优化。

---

## 常用命令

```bash
npm start          # 启动服务
npm run migrate    # 初始化/升级数据库结构
npm test           # 端到端自检（43 项断言）
npm run loadtest   # 容量压测（默认 500 连接）
npm run drill      # 回滚演练（备份 → 校验 → 恢复 → 比对）
npm run capture    # 用无头 Chrome 对真实页面截图（需先启动服务）
```

真实页面截图见 `docs/screenshots/`（登录页 / 群聊页 / 成员面板 / 移动端 / 发送后状态）。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [部署说明](docs/01-deployment.md) | 服务器要求、环境变量、启动与升级、域名与证书 |
| [验收走查清单](docs/02-acceptance-checklist.md) | 逐条验收标准与对应证据 |
| [异常路径处理](docs/03-error-paths.md) | 断线重连、重复、失败、越权、限流与封禁 |
| [可观测性](docs/04-observability.md) | 日志字段、指标接口、台账查询与导出 |
| [回滚方案](docs/05-rollback.md) | 版本回退、数据库回滚、备份恢复 |
| [交接说明](docs/06-handoff.md) | 目录导览、模块职责、迭代建议、已知限制 |
| [多智能体接入](docs/07-multi-agent.md) | Agent 身份/令牌机制、四个 Agent 的接入状态与开启方法、**每 Agent 模型下拉栏**、防打架闸门、失败兜底 |

---

## 已知限制

- 单进程内存态订阅表：水平扩展需引入 Redis 广播（见交接文档的迭代建议）。
- 消息类型目前为文本与图片；语音/视频/大文件未实现（按约定属于后续版本）。
- 无端到端加密、无第三方登录、无多语言。
