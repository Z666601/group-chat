# 交接说明

面向接手这套代码的工程师。10 分钟读懂结构、职责、改动入口与已知边界。

---

## 1. 目录导览

```
group-chat/
├─ README.md                    项目总览与一键启动
├─ package.json                 脚本入口（零依赖）
├─ .env.example                 环境变量样例
├─ server/                      后端（7 个模块，共约 2000 行）
│  ├─ index.mjs                 服务入口：HTTP、静态资源、WS 挂载、心跳维护、优雅关闭
│  ├─ http.mjs                  REST 路由表 + 鉴权/权限/审计注入（约 25 条路由）
│  ├─ ws.mjs                    RFC6455 WebSocket 服务端（握手、帧解析、分片、掩码校验、心跳）
│  ├─ hub.mjs                   实时中枢：订阅表、广播、断线补齐、在场、限流、消息落库
│  ├─ auth.mjs                  scrypt 口令散列、会话令牌、Cookie、输入规则
│  ├─ db.mjs                    SQLite 数据访问层（用户/会话/群/成员/消息/附件/审计）
│  └─ util.mjs                  日志、指标、令牌桶限流、HTTP 小工具
├─ web/                         前端（零构建）
│  ├─ index.html                页面骨架
│  ├─ app.js                    单页应用（约 900 行）
│  └─ styles.css                样式（含响应式）
├─ db/schema.sql                建表与索引（幂等 DDL）
├─ scripts/                     migrate / start-dev.ps1 / start-dev.sh
├─ tests/                       smoke.mjs（43 项断言）、loadtest.mjs（500 连接压测）
└─ docs/                        6 份交付文档
```

---

## 2. 核心模块职责

### `server/ws.mjs` — 为什么要自己实现 WebSocket
为了做到**零依赖**（不需要 `ws` 包，也就不需要 `npm install`，干净环境两条命令即可跑）。实现了 RFC6455 的必要子集：

- 握手：`Sec-WebSocket-Accept = base64(sha1(key + GUID))`
- 帧解析：FIN/opcode/掩码/7-16-64 位长度，分片重组（continuation frame）
- 掩码校验：客户端帧必须掩码，否则以 `1002` 关闭
- 控制帧：ping / pong / close
- 心跳：30 秒主动 ping，两个周期无响应则断开

> 若要替换成 `ws` 或 `socket.io`，只需保持 `onConnection(conn, req)` 与 `conn.send/sendJSON/close/on('message')` 这组接口。

### `server/hub.mjs` — 实时语义都在这里
- `rooms`：`Map<groupId, Set<conn>>` 内存订阅表
- `subscribe`：校验成员身份 → 注册订阅 → 按 `sinceSeq` 补发 → 回 `subscribed` → 广播在场
- `persistAndFanout`：幂等检查 → 校验（空/超长）→ 令牌桶限流 → 事务内分配 `seq` 并落库 → 回 `ack` → 广播
- `checkRate`：按用户维度的令牌桶

**改限流**：`DEFAULT_LIMITS.msgRateCapacity` / `msgRateRefillPerSec`。

### `server/http.mjs` — 路由与权限
- `add(method, pattern, handler, opts)` 注册；`pattern` 支持 `:param`；`opts.auth`（默认非 admin 路由为 true）、`opts.admin`（需 `x-admin-token`）
- 权限判定用 `store.members.isActive()` 与 `role === 'owner'`，**每次请求都判**，并在拒绝时写审计

**加一个新接口**：在 `createRouter()` 里加一行 `add('GET', '/api/xxx', handler)` 即可，鉴权与审计自动接入。

### `server/db.mjs` — 数据层
所有 SQL 都集中在此，页面/接口层不写裸 SQL。新增查询请在此处加方法，便于统一维护索引与事务。

### `web/app.js` — 前端状态机
- `state`：分组消息缓存、`seqIndex`（去重）、`outbox`（发送中/失败状态机）、`online`
- `connectSocket()` / `scheduleReconnect()` / `subscribe()`：指数退避重连 + `sinceSeq` 补齐
- `handleServerEvent()`：`message` / `subscribed` / `ack` / `error` / `member-changed` / `group-dissolved` 等事件分发
- `dispatchOutbox()`：实时通道可用走 WS，否则降级走 REST

---

## 3. 常见改动入口

| 想改什么 | 改哪里 |
|---|---|
| 消息长度 / 图片大小上限 | `.env`（`MAX_TEXT_LENGTH` / `MAX_IMAGE_MB`），或 `hub.mjs` 的 `DEFAULT_LIMITS` |
| 单群人数上限 | `.env` 的 `MAX_GROUP_MEMBERS` |
| 限流强度 | `hub.mjs` 的 `DEFAULT_LIMITS` |
| 新增消息类型（如文件） | `messages.type` + `hub.mjs` 的 `persistAndFanout` + `web/app.js` 的 `buildMessage` |
| 界面配色 / 字体 | `web/styles.css` 顶部的 CSS 变量（`--accent`、`--link`、`--font`） |
| 登录规则（用户名/密码长度） | `auth.mjs` 的 `validateCredentials` 与 `usernamePattern` |
| 新增审计事件 | 调用 `store.audit.log({ type, actorId, groupId, detail, ip })` |
| 新增数据库字段 | 改 `db/schema.sql`（幂等），并在 `db.mjs` 对应方法里读写 |
| 接 HTTPS / 域名 | 反代层处理（见部署文档第 5 节），代码无需改 |

---

## 4. 数据模型速览

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | `id, username(唯一), display_name, password_hash, status` | `status`: active/banned |
| `sessions` | `token(PK), user_id, expires_at` | 会话有效期 30 天 |
| `groups` | `id, name, owner_id, invite_code(唯一), status` | `status`: active/dissolved |
| `group_members` | `(group_id, user_id) PK, role, removed_at, last_read_seq` | `removed_at` 软删除，便于审计 |
| `messages` | `id, group_id, seq, sender_id, type, body, attachment_id, client_msg_id` | `UNIQUE(group_id, seq)`；`UNIQUE(group_id, sender_id, client_msg_id)` 为幂等键 |
| `attachments` | `id, uploader_id, mime, size, path` | 图片落盘，路径由本服务托管 |
| `audit_log` | `ts, type, actor_id, group_id, target_id, detail, ip` | 只增不改 |

---

## 5. 验证方式

```bash
npm test           # 47 项端到端断言（注册→建群→实时→越权→限流→重连→已读回执→台账→解散）
npm run loadtest   # 500 连接 / 200 消息 容量基线
```

自检产物：`data/smoke/smoke-report.json`；压测产物：`data/load/loadtest-report.json`。

---

## 6. 后续迭代建议（按优先级）

### P0 — 水平扩展
当前订阅表在进程内存里，无法多实例。改造路径：
1. 引入 Redis（或 NATS）发布订阅
2. `hub.broadcast()` 改为「本地扇出 + 发布到频道」
3. 各实例订阅频道，收到后只扇出给本地连接
4. `seq` 分配改为数据库自增或 Redis INCR，避免多实例竞争

### P1 — 消息可靠性
- 落库与广播之间增加**发件箱（outbox）**或事件日志，确保进程崩溃后仍能补发
- ~~已读回执~~ ✅ 已实现（2026-09-26）：客户端与 Agent 桥接器发 `{"type":"read","groupId","seq"}`，服务端只前进游标并在推进时向他人广播 `read-receipt`；前端在消息流插入「以下是未读」分割线，标题栏显示「已读 x/n」。见 `tests/smoke.mjs` 第 10b 节

### P2 — 产品能力
- 消息编辑 / 撤回（软删除字段 `deleted_at` 已预留）
- 图片缩略图与 CDN 化
- 群主转让、管理员角色（`role` 已可扩展）
- @提及与消息搜索（`messages` 可加 FTS5 虚拟表）

### P3 — 安全加固
- 管理操作封装成带审计的接口（当前需直接改库）
- 登录失败次数限制与图形验证码
- 内容安全审核接入

---

## 7. 已知限制

| # | 限制 | 影响 | 备注 |
|---|---|---|---|
| 1 | 单进程内存订阅表 | 不能多实例水平扩展 | 见 P0 |
| 2 | 无 E2E 加密 | 符合当前业务场景 | 按约定不在本期范围 |
| 3 | 无语音/视频/大文件 | 按约定属后续版本 | — |
| 4 | 无第三方登录 / SSO | 按约定不在本期范围 | — |
| 5 | 仅简体中文 | 按约定不做 i18n | — |
| 6 | 消息不做物理删除 | 磁盘随体量增长 | 需按数据保留策略清理 |
| 7 | 图片无缩略图 | 大图首屏较慢 | 见 P2 |
| 8 | 群解散后消息保留 | 便于审计 | 如需清除见回滚文档 |

---

## 8. 排障速查

| 现象 | 排查 |
|---|---|
| 页面打不开 | `curl /healthz`；看 `data/logs/app.log` 的 `server.listening` |
| 实时消息不推送 | 反代是否透传 `Upgrade`/`Connection` 头；浏览器控制台是否 WS 连接失败 |
| 「已断开」反复出现 | 心跳超时；检查网络与代理的读超时（建议 `proxy_read_timeout 3600s`） |
| 消息发出去但对方收不到 | 检查对方是否为群成员；查审计 `authz_denied` |
| 频繁「发送失败」 | 是否触发限流（查 `abuse.rate_limited`）；WS 是否断开 |
| 图片显示失败 | 是否仍为群成员（附件带成员校验）；文件是否被清理 |
| 数据库锁等待 | 检查是否有其他进程直连写库；WAL 模式下应很少见 |
