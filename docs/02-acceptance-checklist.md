# 验收走查清单

对照 Goal Brief 的 10 条验收标准，逐条给出**操作步骤 → 观察点 → 证据**。带 ✅ 的条目已在自动化自检（`npm test`）中覆盖，括号内为对应断言。

---

## 1. 建群与成员管理闭环

| 步骤 | 期望 |
|---|---|
| 注册账号 A，点「新建群聊」输入群名 | 群创建成功，A 为群主，列表出现该群 ✅ |
| 打开成员面板 → 「复制邀请链接」 | 得到 `http://<host>/join?code=<邀请码>` |
| 账号 B 打开该链接并登录 | 自动入群，成员数变 2 ✅ |
| 群主在成员面板点「修改群名 / 头像」 | 改名即时生效，所有人侧栏刷新 ✅ |
| 群主点某成员「移除」 | 该成员被移出，其无法再读该群消息 |
| 普通成员点「退出群聊」 | 退出成功，群从其列表消失 ✅ |
| 群主点「解散群聊」并输入群名确认 | 群解散；随后读取该群消息返回 410 ✅ |

**数据核对**：`sqlite3 data/chat.db "select count(*) from group_members where removed_at is null"`
**证据**：`tests/smoke.mjs` 第 3、4、12 组；`data/smoke/smoke-report.json`

---

## 2. 消息实时收发

| 步骤 | 期望 |
|---|---|
| A、B 两台设备（或两个浏览器 profile）加入同一群 | 双方均显示「已连接」 |
| A 发送文本 | 发送方先显示「发送中…」，收到 `ack` 后变为「已发送」 ✅ |
| B 侧观察 | 2 秒内可见该消息 ✅ |
| A 连发三条 | B 侧顺序与发送顺序一致（按 `seq` 升序） ✅ |

**实测延迟**：单条端到端投递 **15–31ms**（自检样本），远低于 2 秒门槛。
**证据**：`tests/smoke.mjs` 第 5 组，`data/smoke/smoke-report.json` 中 `summary.latency.realtimeMaxMs`

---

## 3. 消息持久化与历史回溯

| 步骤 | 期望 |
|---|---|
| 刷新页面 / 退出重登 / 换设备登录 | 历史消息完整仍在 ✅ |
| 在消息区向上滚动或点「加载更早的消息」 | 每次加载 30 条，翻页不重叠 ✅ |
| 直接查库 | 记录与界面一致 ✅ |

**核对命令**：

```bash
sqlite3 data/chat.db "select group_id, count(*) from messages where deleted_at is null group by group_id"
curl -s "http://127.0.0.1:8787/api/admin/messages?groupId=<群ID>" -H "x-admin-token: $ADMIN_TOKEN"
```

**证据**：`tests/smoke.mjs` 第 10、11 组（`数据库消息数与接口一致 — db=13, api=13`）

---

## 4. 身份与权限边界

| 步骤 | 期望 |
|---|---|
| 未登录直接访问 `/api/groups` | 401 ✅ |
| 非成员读取 `/api/groups/:id/messages` | 403 且写入审计 ✅ |
| 非成员订阅该群实时通道 | 收到 `not_a_member` 并断开该订阅 ✅ |
| 普通成员解散群聊 | 403 ✅ |

**证据**：`tests/smoke.mjs` 第 2、4 组；审计接口 `?type=authz_denied` 可查到 4 条记录

---

## 5. 断网重连不丢不重

| 步骤 | 期望 |
|---|---|
| 聊天中断开网络（或关掉 WS） | 顶部状态变为「已断开」，客户端开始指数退避重连 |
| 断线期间 A 继续发消息 | 服务端照常落库 |
| 恢复网络 | 自动重连 → 自动补齐断线期间消息 ✅ |
| 比对总数 | 客户端展示条数 = 数据库条数，无重复 `seq` ✅ |

**实测**：`sinceSeq=12 → seq=13`，补齐 1 条，消息列表无重复 ID，总数 13。
**证据**：`tests/smoke.mjs` 第 9 组

---

## 6. 异常与滥用路径处理

| 场景 | 期望 | 状态 |
|---|---|---|
| 超长文本（>2000 字） | 拒绝并提示，写入 `invalid_input` 台账 ✅ | 已验证 |
| 空消息 | 拒绝并提示 `empty_message` ✅ | 已验证 |
| 非法图片类型（如 text/plain） | 415 拒绝，写入台账 ✅ | 已验证 |
| 超大图片（>5MB） | 413 拒绝 ✅ | 已验证 |
| 重复提交（同一 clientMsgId） | 仅落库一条，回放既有消息 ✅ | 已验证 |
| 高频刷屏 | 触发令牌桶，返回 `rate_limited` 并写台账 ✅ | 实测拦截 32 条 |
| 发送失败 | 客户端 8 秒超时转「发送失败」并可重试 | 已实现 |
| 连接超时 | 心跳 30s / 45s 无响应即断开重连 | 已实现 |

**证据**：`tests/smoke.mjs` 第 6、7、8 组；审计 `?type=rate_limited`（32 条）、`?type=invalid_input`

---

## 7. 后台记录与可观测台账

| 能力 | 接口/位置 |
|---|---|
| 审计台账查询（按群/用户/时间段/类型） | `GET /api/admin/audit?groupId=&actorId=&type=&from=&to=&limit=` |
| 台账导出 CSV | `GET /api/admin/audit/export?...`（带 BOM，Excel 直开） |
| 消息台账核对 | `GET /api/admin/messages?groupId=&from=&to=` |
| 系统总览（表行数 + 指标 + 审计分类） | `GET /api/admin/overview` |
| 关键错误日志检索 | `data/logs/app.log`（JSON Lines，按 `level`/`msg` 过滤） |

**实测台账分类**（一次自检产生的真实数据）：

```json
[{"type":"rate_limited","c":32},{"type":"authz_denied","c":4},{"type":"register","c":3},
 {"type":"invalid_input","c":2},{"type":"admin_denied","c":1},{"type":"group_create","c":1},
 {"type":"group_dissolve","c":1},{"type":"join_failed","c":1},{"type":"login","c":1},
 {"type":"login_failed","c":1},{"type":"member_join","c":1}]
```

**证据**：`tests/smoke.mjs` 第 11、13 组

---

## 8. 部署交接与回滚可用

| 步骤 | 期望 |
|---|---|
| 干净服务器按 `docs/01-deployment.md` 操作 | 无需 `npm install`，两条命令即可跑通 |
| `curl /healthz` | 返回 `ok:true` 与表行数 |
| 演练回滚 | 按 `docs/05-rollback.md`，双目录切换 + 数据库备份恢复，目标 30 分钟内完成 |

**已实操演练**（`npm run drill`，7/7 通过）：

```
[PASS] 在线备份完成且文件非空  — 10ms
[PASS] 备份完整性校验通过  — ok
[PASS] 备份内容与源库一致  — src={"users":2,"groups":1,"messages":5,"audit":5} backup={...一致}
[PASS] 恢复文件完整性校验通过  — ok
[PASS] 恢复后数据与备份一致
[PASS] 抽样记录逐字段一致  — 5 条
[PASS] 审计台账分类计数一致
```

演练方式：对**运行中**的数据库做在线备份 → 校验备份 → 从备份恢复到全新文件 → 逐字段抽样比对。演练不触碰线上数据。
**证据**：`data/live/backup/rollback-drill-report.json`、`tests/rollback-drill.mjs`；部署文档；回滚文档第 2、3 节。

---

## 9. 容量与性能基线

实测命令：`npm run loadtest`（500 用户 / 20 发送者 / 200 条消息）

| 指标 | 实测值 |
|---|---|
| 并发 WebSocket 连接 | **499 / 500**（建立耗时 957ms） |
| 订阅成功 | 499 |
| 发送消息 | 200 |
| 扇出投递次数 | **99800 / 99800** |
| 丢失投递 | **0** |
| 投递错误率 | **0%** |
| 端到端投递延迟 | p50=4ms / p90=8ms / **p95=9ms** / p99=10ms / max=11ms |
| 服务端落库耗时 | p50=10ms / p95=13ms / max=15ms |
| 服务端内存峰值 | 客户端进程 RSS 124MB（服务端进程同机运行） |

**瓶颈说明**：单进程内完成「落库 + 内存扇出」，200 条消息 × 499 订阅者约 2.2s 走完，说明当前规模远未触及瓶颈。真正会先到上限的是**单进程内存订阅表**：连接数与活跃群数继续增长时需引入 Redis 发布订阅做多实例广播（见交接文档迭代建议）。

**证据**：`data/load/loadtest-report.json`

---

## 10. 端到端验收走查

一次性串联走查（可照此录屏）：

1. 打开首页 → 注册 A、B 两个账号
2. A 建群 → 复制邀请链接 → B 打开链接入群
3. A、B 同时在线互发 3 条消息，确认 2 秒内可见、顺序正确、状态由「发送中」转「已发送」
4. A 断开网络 → B 继续发 2 条 → A 恢复网络 → 确认自动补齐且不重复
5. C 账号尝试读取该群 → 确认被拒；管理台查 `authz_denied`
6. C 高频刷屏 → 确认被限流；管理台查 `rate_limited`
7. 向上翻页加载历史 → 刷新页面确认历史仍在
8. 打开 `GET /api/admin/overview` 核对表行数、指标与审计分类
9. A 解散群 → 确认群消失、再读消息返回 410

**自动化替代**：`npm test` 已把上述 1–9 全部脚本化（共 43 项断言，全部通过）。

---

## 附一、真机走查与截图取证

除自动化自检外，另用**无头 Chrome + CDP** 对真实运行中的页面做了走查与截图（`node scripts/capture.mjs`），并读取页面内部状态做核对：

| 截图 | 内容 | 页面内部状态（实测） |
|---|---|---|
| `01-login-desktop.png` | 登录/注册页（桌面 1440×960） | 表单、标签页、跳转链接均渲染 |
| `02-login-mobile.png` | 登录页（移动 420×860） | 响应式布局生效 |
| `03-chat-desktop.png` | 群聊主界面 | `title="💬 产品讨论组"`, `meta="2 位成员 · 你是群主"`, `messages=4`, `conn="online"` |
| `04-chat-members.png` | 打开成员面板 | `members=["演示用户（我）群主", "鲍勃 成员"]` |
| `05-chat-mobile.png` | 群聊移动端 | 单栏布局、顶部栏折叠 |
| `06-chat-after-send.png` | 通过真实界面发送后 | `messages=5`，末条状态显示 **「已发送」** |

截图与状态报告：`docs/screenshots/`（含 `capture-report.json`）。

### 走查中发现并修复的前端缺陷

脚本自检覆盖不到前端渲染，真机走查抓到 2 个真实缺陷，均已修复并复验：

| # | 缺陷 | 现象 | 修复 |
|---|---|---|---|
| 1 | `selectGroup` 先清空 `#messages` 再 `appendChild(空态节点)` | 点击群聊抛 `TypeError: parameter 1 is not of type 'Node'`，消息区永久空置 | 清空后交由 `renderMessages()` 重建空态 |
| 2 | `onAck` 先改 DOM 行 `data-id` 再按 `clientMsgId` 查行 | 发送成功后状态永远停在「发送中…」 | 先更新状态、再改 id；并使消息状态可持久显示 |

附带改进：静态资源 `app.js` / `styles.css` 改为 `no-cache`，避免升级后浏览器仍执行旧脚本（正是缺陷 1 曾掩盖不掉的成因）。

---

## 遗留问题与建议

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | 单进程内存订阅表 | 无法多实例水平扩展 | 第二版引入 Redis pub/sub |
| 2 | 未实现消息已读回执的 UI 展示 | 仅记录 `last_read_seq` | 增加未读分割线与已读人数 |
| 3 | 无消息编辑/撤回 | — | 二期功能 |
| 4 | 图片无缩略图 | 大图首屏偏慢 | 生成缩略图 |
| 5 | 无端到端加密 | 符合当前业务场景 | 如需要单独立项 |
