# 架构决策记录

格式：每条 ADR 只增不改正文；被推翻时新写一条，并在旧条目状态栏写 `Superseded by ADR-NNN`。

| ADR | 决策 | 状态 | 版本 |
|---|---|---|---|
| 001 | 影子固定 `danger-full-access`，不注册审批 hook | Accepted | 0.10.0 |
| 002 | 影子身份由会话 `cwd` 决定，不由 preset 决定 | Accepted | 0.2.0 |
| 003 | 插件不含工作账本 | Accepted | 0.2.0 |
| 004 | 删除出网分类器及其测试 | Accepted | 0.12.0 |
| 005 | `lib/` 扁平分层模块 + 架构测试 | Accepted | 0.12.0 |
| 006 | 测试用例编号 + 文档对账；设计文档不进 npm 包 | Accepted | 0.12.0 |
| 007 | 投递只走 `agent.send` 中继，不走 `sessionController.prompt` | Accepted | 0.2.0 |
| 008 | 显式 selection 接受"同时保存为全局默认"的官方副作用 | Accepted | 0.2.0 |
| 009 | 影子的子代理降为 `workspace-write`，审批保持 `never` | Accepted | 0.12.0 |
| 010 | 发布到 npm（`dsh-plugin-shadow`） | Accepted | 0.12.0 |
| 011 | 本机保留 `D:\DSH\shadow` 作为影子目录 | Accepted（待执行 TASK-08） | 0.12.0 |
| 012 | `shadow_inspect` 加 `replyAfterSeq`：读目标的最新回复全文 | Accepted | 0.13.0 |
| 013 | 三层防护运行时漂移：`engines.dsh` + 读取时形状检查 + 真实日志探针 | Accepted | 0.13.0 |

## ADR-001 完全权限、无审批

- **背景**：0.2–0.9 使用 `auto` + 官方 auto-review，并自建出网守卫。每次工具调用评审耗时 6–53 秒；守卫误报多，维护成本高（11 轮对抗修补）。
- **决策**：影子目录内的会话固定 `danger-full-access`；工具入口不注册 `tools/pre-execute` hook。
- **后果**：影子快，但对提示注入没有运行时闸门。缓解措施见 `overview-design.md` §8（TASK-01、TASK-03、TASK-04）。
- **重新评估的触发条件**：影子开始处理不可信来源（网页、外部 issue）且无人值守；或出现一次影子按注入内容行动的事故。重新引入闸门时新写 ADR，不要直接恢复旧代码。

## ADR-002 身份跟着目录

- 会话头记录的 preset 会被后续 `agent-preset/selected` 覆盖，不可信；`cwd` 创建后不变。
- host、tools、client 三处用同一条规则（`shadow-dir.js`）。tools 行与 host 行必须配置相同的 `shadowDir`。

## ADR-003 不含工作账本

账本回答"这件事做完了没有"，属于独立领域。将来需要时做成独立插件，通过会话日志与影子对接。

## ADR-004 删除出网分类器

- 0.10.0 之后 `inspectEgress` 等约 1100 行代码不再被运行时调用，却仍随包发布、计入构建戳，并由 fuzz 与 23 个跳过的仿真场景维护。
- 0.12.0 删除源码与测试。最后一个版本在 tag `archive/egress-classifier`（commit `8daf2c3`）。
- 若将来需要出网控制，按 ADR-001 的重新评估流程另起设计。

## ADR-005 扁平分层模块

- `dispatch-core.js`（1611 行）与 `tools.js`（657 行）拆成 `core-*` / `host-io` / `op-*` / entry 四层。
- 保持 `lib/` 扁平：`sync.mjs`、`pack-check.mjs`、`build-stamp.js` 都按 `lib/*.js` 枚举，子目录会让三处同时失效。
- `dispatch-core.js` 保留为只含 re-export 的兼容入口。
- 规则由 `tests/arch.test.mjs` 强制。

## ADR-006 用例编号与文档对账

- 所有套件使用 `tests/harness.mjs`；每个用例 `TC-<AREA>-<NNN>`。
- `tests/tc-index.mjs` 检查编号唯一、索引最新、`todo` 都有规格、规格状态与代码一致、代码引用的任务卡存在。
- `docs/` 不发布到 npm；README 中指向设计文档的链接使用仓库绝对 URL。

## ADR-007 中继投递

`sessionController.prompt` 只接受 `user-rpc` 来源，无法记录"谁派来的"。`agent.send(message, 'next-turn', true)` 允许 `source={kind:'agent-message', form:'relay', senderSessionId}`，满足不变量 4。

## ADR-008 selection 的副作用

`sessionController.selectModel` 会把选择保存为全局默认（官方行为）。不提供"仅本次"语义；工具描述中已告知模型。

---

## ADR-009 子代理不给完全权限

- **决策人**：用户（2026-11-06，"子智能体不能给权限"）。
- **运行时事实**（从 rc.3 `app.asar` 读出）：
  - `dsh-subagent` 的 `captureDelegatedPolicyOverrides` 把父会话的 `danger-full-access` 复制到子会话日志，并把子会话审批策略固定为 `never`；子会话头的 `cwd` 取自父会话，`parentSession` 为父 id。
  - 这些事件在子会话 setup 阶段写入；`session/created` 在 setup 之后由 `dsh-agent-loop` 的 publish 触发。
  - 官方 `pinInitialPermission` 只补缺失项，不覆盖已有的 `sandbox/mode`。
- **因此**：只是"不再固定子代理"没有用，子代理仍会继承完全权限。host 半边必须主动写一条 `sandbox/mode = workspace-write`。
- **决策**：影子目录内、`header.parentSession` 存在的会话，在 `session/created` 和挂载时写入 `sandbox/mode = workspace-write`；已是该值则不写。审批保持继承来的 `never`：越权操作立即被拒绝，不会卡在没人回答的审批上。
- **后果**：子代理只能写影子目录和允许的临时目录。需要改别的项目时，影子应当用 `shadow_dispatch` 把活派给那个项目的会话，而不是派子代理。composer 里子会话的权限显示为 `custom`（`workspace-write` + `never` 不对应任何预设）。
- **依赖**：`sandbox/mode` 事件形状 `{mode}`（与 `dsh-sandbox-policy` 的 `setSandboxMode` 相同）、`session.append`、`session.snapshotEvents()`。见 `detailed-design.md` §7。
- **测试**：TC-HOST-015 至 TC-HOST-018；端到端 TC-E2E-004。

## ADR-010 发布到 npm

- **决策人**：用户（2026-11-06，"要发布"）。
- 包名 `dsh-plugin-shadow`（2026-11-06 查询 registry 未被占用）。tarball 只含 `lib/`、`cordis.patch.yml`、README、CHANGELOG、LICENSE。
- 发布需要维护者在本机 `npm login`；步骤见 `operations.md` §6。

## ADR-011 本机保留旧影子目录

- **决策人**：用户（2026-11-06，按建议）。保留 `D:\DSH\shadow` 的 20 个会话与台账，不迁移到 `<home>/dsh-shadow`。
- 执行方式见 TASK-08 / `operations.md` §4。因为要改正在运行的 profile 并重启 DSH，执行前仍需用户确认时机。

## ADR-012 读取目标的回复

- **问题**：影子能派活，却读不到结果。`shadow_inspect` 的事件页每条最多 200 字符，而且是 `data` 的 JSON 前缀，对 `assistant/message` 来说是 `{"turn":1,"step":2,"message":{"role":…`，看不到回复正文。
- **考虑过的方案**：
  - (a) 新工具 `shadow_reply`：工具名是契约，多一个工具多一份 preset 上下文；功能与 inspect 高度重叠。
  - (b) 投递后阻塞等待目标回复：工具调用会挂几分钟，影子在此期间什么也做不了；目标是否"做完"本来就需要判断。
  - (c) **给 `shadow_inspect` 加可选参数 `replyAfterSeq`**：选这个。不传时输出与 0.12 完全相同；传了就在末尾附一个回复块。
- **语义**：只看 `seq > replyAfterSeq` 的事件。回复 = 最后一条带可见文字的 `assistant/message`（只取 `text` 块；`reasoning` 是目标的私有思考，不外泄；`tool-call` 只计数）。上限 8000 字符，超出取开头并注明。同时报告 assistant 消息数、工具调用数、结束了几轮、最后一轮怎么结束的（`completed`/`aborted`/`error` 带错误信息）。
- **为什么取"最后一条"而不是全部拼接**：干活的会话会在工具调用之间写过程说明，最后一条才是结论；拼接会把 8000 字符的额度花在过程上。需要过程时用 `afterSeq` 事件页。
- **安全**：回复块前固定一行 `untrusted: …`；事件页同样加这一行（TASK-03 一并完成）。
- **用法**：`shadow_dispatch` 的描述里告诉模型用回执里的 `inbox@<n>` 作为 `replyAfterSeq`。回执格式本身不变。
- **测试**：TC-CORE-047 至 051、TC-INS-008、009，以及 TC-RTC-001。

## ADR-013 DSH 自动更新后不悄悄失效

- **问题**：DSH 从 GitHub 自动更新（`resources/app-update.yml`）。插件读的是内部形状（lease 字段、事件字段），没有公共 API 保证。更新改了字段名时，旧实现的表现是"证据扫描找不到消息"，也就是把已投递的消息当成没投递，可能**重复投递**；或者模型看到莫名其妙的错误。原有启动预检只检查服务存在，不检查形状。
- **决策：三层，各管一段。**
  1. **版本门（加载时，官方机制）**：`package.json` 声明 `engines.dsh: ">=0.2.1-rc.3 <0.2.2-0"`。DSH 的 `dsh-app-boot` 在加载 profile 时调用 `evaluatePluginCompatibility`，范围外的版本直接禁用本插件，并打印带豁免命令的警告。上界取 `<0.2.2-0`，是为了把 `0.2.2-rc.*` 也排除在外（已用 semver 验证：rc.3、rc.4、0.2.1 在内，0.2.2-rc.1、0.2.2 在外）。
  2. **形状检查（运行时，范围内的漂移）**：同一版本线里的 rc 也可能改字段。`core-shape.js` 只检查插件真正读的字段：挂载时检查服务方法；每次 `readLog` 检查 lease 与被折叠的 6 种事件。不符时三个工具返回 `runtime-mismatch` 并附具体字段，**投递在发送前就拒绝**，不会因误读而重复投递。host 半边服务漂移时不固定任何会话，只打一行 warn。
  3. **真实日志探针（维护者，放宽范围前）**：`node scripts/contract-probe.mjs --home <DSH_HOME> --asar <app.asar>` 用本机最近的真实会话日志跑同一套检查，并打印已安装的运行时版本。2026-11-06 对 30 份日志运行，0 误报。
- **为什么不用精确版本 `0.2.1-rc.3`**：每次 rc 更新都会让插件消失，用户得反复手动豁免；而 rc 之间多数情况下形状不变，第 2 层已经兜住了范围内的漂移。
- **为什么不只用第 2 层**：跨大版本时可能不只是字段改名，而是整套服务换掉；在加载阶段拒绝比运行时报错更早、更干净。
- **测试**：TC-RTC-001 至 007、TC-INS-010、TC-DSP-026、TC-REG-002、TC-HOST-019；端到端 TC-E2E-006。

---

## 未决问题

| # | 问题 | 选项 | 建议 | 决策人 |
|---|---|---|---|---|
| Q1 | ~~子代理是否固定完全权限~~ | | 已决：ADR-009 | |
| Q2 | ~~本机影子目录~~ | | 已决：ADR-011 | |
| Q3 | 跨影子实例对同一目标的竞态是否需要测试？ | (a) 在仿真里加两个 tools 实例共享一个 world；(b) 维持论证 | (a)，成本低 | 维护者 |
| Q4 | ~~发布渠道~~ | | 已决：ADR-010 | |
| Q5 | "已确认监管项目"清单目前手写在影子工作目录的 `REGISTRY.md`，是否需要工具化？ | (a) 维持手写；(b) 独立账本插件（ADR-003） | 先 (a)，有 3 个以上项目再评估 | 用户 |
