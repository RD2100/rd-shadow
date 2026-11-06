# dsh-plugin-shadow（影子总控）

> 你自己的 DSH 会话管理不过来时，让一个会话站在你的视角上，替你盯着进度、把活派给正确的会话。

**仓库**：[RD2100/rd-shadow](https://github.com/RD2100/rd-shadow)　**包名**：`dsh-plugin-shadow`

*[English](README.en.md)*

影子是一个**住在专属目录里的 DSH 会话**，有三个工具：

| 工具 | 作用 |
|---|---|
| `shadow_targets` | 列出工作区与会话：id、实时状态（`idle`/`cold`/`busy`）、归档与子代理标记、标题 |
| `shadow_inspect` | 只读查看一个会话：状态、工作目录、当前模型、事件序号；可按 `afterSeq`/`limit` 分页读事件；传 `replyAfterSeq`（投递回执里的 `inbox@` 序号）可读到目标之后的最新回复全文，以及这一轮是否结束。不唤醒冷会话 |
| `shadow_dispatch` | 向一个会话投递一条消息。消息带 `source={kind:'agent-message', form:'relay', senderSessionId}`，接收方日志能重建"是谁派来的" |

投递是幂等的：同一次工具调用被重放，得到同一 message id，不会重复投递。想再发一次就重新调用。

| 回执 `status` | 含义 |
|---|---|
| `durable` | 已写入目标日志并被采纳进轮次 |
| `accepted` | 已进入目标收件箱，还没被采纳 |
| `already-delivered` | 这条消息之前已经投递过 |
| `rejected` | 未投递，`reason` 说明原因（`busy`/`pending`/`archived`/`workspace-session-mismatch`/…） |
| `unknown` | 发送后失去确认能力。**不要重试**，重试会产生新的 message id；请用 `shadow_inspect` 核对 |

## 权限与安全

影子会话固定使用 `danger-full-access`，工具调用不等待审批（见 [决策 ADR-001](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md)）。影子可以读写完整文件系统并访问外网，也会读到别的会话里的内容。只在你信任影子指令和工作区内容时使用。影子派生的子代理**不**继承完全权限：插件把它们降为 `workspace-write`，需要更大权限的操作直接被拒绝（[ADR-009](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md)）。

## 要求

| 项 | 要求 |
|---|---|
| DSH | harness `>=0.2.1-rc.3 <0.2.2`（在 `dsh-desktop-next 2.0.20-next` 上核验）。依赖内部服务契约：范围外的版本会被 DSH 加载器直接禁用；范围内若字段变了，工具返回 `runtime-mismatch` 而不是给出错误结果。DSH 更新后的复核见[运维手册 §5](https://github.com/RD2100/rd-shadow/blob/main/docs/operations.md) |
| Node | `>= 22.19` |
| profile | 带 GUI 的 web / desktop profile（本插件有浏览器半边） |

## 安装

- **desktop profile**：应用内插件页，或让 agent 调 `plugin_manager` 的 `install_bundle spec=<本仓库路径>`。
- **web / tui profile**：`dsh plugin --profile web add <本仓库路径或 https://github.com/RD2100/rd-shadow>`。
- **手动**：profile `package.json` 的 `dsh.profile.bundles` 加 `"dsh-plugin-shadow"`，`dependencies` 加 `"dsh-plugin-shadow": "file:<本仓库路径>"`。

## 配置

`shadowDir` 是影子的身份：`cwd` 等于它的会话才是影子，才被固定权限并获得三个工具。默认 `<家目录>/dsh-shadow`，设置了 `SHADOW_DIR` 时用它的值。

**换影子目录：在 DSH 数据目录的 `.env`（`<DSH_HOME>/.env`）里写一行 `SHADOW_DIR=<目录>`**，然后完全重启 DSH。host 行和 preset 内的 `shadow-tools` 行都先读这个变量，所以两边总是一致。不要在 profile patch 里改 `shadowDir`：嵌在 preset 里的那一行改不到；也不要用 `DSH_` 开头的变量名，DSH 会拒绝启动（[ADR-015](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md)）。从 0.11.0 之前升级、想保留原来的影子目录时，按 [运维手册 §4](https://github.com/RD2100/rd-shadow/blob/main/docs/operations.md) 设置这个变量。

启动后宿主日志应有这四行：

```text
shadow: directory <影子目录>
shadow: build <12 位哈希>        ← 与 checkout 里 node scripts/fingerprint.mjs 的输出相同
shadow: permission identity danger-full-access; interactive approvals are disabled
shadow: subagents of the shadow run in workspace-write with approvals rejected
```

## 已知限制

| 限制 | 说明 |
|---|---|
| 没有交互式审批 | 见"权限与安全" |
| 只支持带 GUI 的 profile | client 半边需要浏览器环境 |
| 改 `lib/*.js` 需要重启 DSH | HMR 不监视插件代码 |
| DSH 版本范围 | 见"要求"；DSH 自动更新出范围后插件会被禁用，直到发布新的核验版本 |

## 开发

```sh
node tests/run.mjs          # 全部离线检查（CI 在 ubuntu/windows × Node 22/24 运行）
```

开发规则、设计和任务都在仓库的 `docs/` 与 `AGENTS.md`（不随 npm 包发布）：

- [AGENTS.md](https://github.com/RD2100/rd-shadow/blob/main/AGENTS.md)：实现者规则
- [概要设计](https://github.com/RD2100/rd-shadow/blob/main/docs/overview-design.md) · [详细设计](https://github.com/RD2100/rd-shadow/blob/main/docs/detailed-design.md) · [测试用例](https://github.com/RD2100/rd-shadow/blob/main/docs/test-cases.md) · [决策](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md) · [任务卡](https://github.com/RD2100/rd-shadow/blob/main/docs/tasks.md) · [运维](https://github.com/RD2100/rd-shadow/blob/main/docs/operations.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
