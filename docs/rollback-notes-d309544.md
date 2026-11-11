# d309544 回滚说明书

`d309544`（三期）把三个功能面合进了一条 commit，回滚粒度失效。本文件是它的解包说明：
**不要求改写历史**（禁 rebase/reset），而是给每个功能面一个独立的回滚锚点——
需要撤某一段时，按「锚点 commit + 反向应用范围」操作，不必连带其余两段。

## 三段构成与锚点

| 功能面 | d309544 中的文件 | 回滚锚点 | 反向应用范围 |
|---|---|---|---|
| ① 多脑调度功能（自动停任务/GLM 直连/话题继承） | `agents/discussion-monitor.mjs`、`agents/verdict-brain.mjs`、`agents/bridge.mjs`、`agents/persona-brain.mjs`、`tests/smoke.mjs` | 本文件 + `git log --agents 范围` 内后续 agents/ 提交 | 对 ① 列出的文件 `git checkout <d309544^> -- <files>` 后单独 commit |
| ② 生产服务安全修复（静态路径边界） | `server/index.mjs`（仅 4 行：serveStatic 的 startsWith → 分隔符收口） | 见下方精确范围 | `git diff d309544^ d309544 -- server/index.mjs` 的反向补丁；注意 673721b 之后 server/index.mjs 另有调度台路由，回滚 ② 时保留它 |
| ③ 桌面挂件入库（首次 add 的 627 行 + open-app 白名单） | `widget/main.js` | 挂件此前从未入库，`d309544^` 即「不存在」状态 | 删除工作区 `widget/main.js` 的 git 跟踪即可（`git rm --cached widget/main.js` + commit），白名单加固随其后丢失需知悉 |

## 检索命令

```bash
git show --stat d309544                 # 三段混排的原始证据
git diff d309544^ d309544 -- server/index.mjs   # ② 的精确 4 行
git log --oneline -- agents/ server/ widget/    # 各功能面后续独立提交（锚点链）
```

## 后续纪律

自本文件起，commit 按功能面拆分：挂件（widget/）、服务端（server/）、多脑调度（agents/ + tests/）
不得在同一 commit 同时出现；跨面改动分多次提交，commit message 标注功能面。
