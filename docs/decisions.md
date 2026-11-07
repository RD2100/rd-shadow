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
| 014 | 影子目录由环境变量 `DSH_SHADOW_DIR` 统一覆盖，不用 profile patch | Superseded by ADR-015 | 0.13.1 |
| 015 | 变量改名 `SHADOW_DIR`，写在 `<DSH_HOME>/.env` | Accepted | 0.13.2 |
| 016 | 浏览器半边按会话识别影子工作区 | Accepted | 0.13.3 |
| 017 | 归档影子保留工作区身份，入口排除子代理 | Accepted | Unreleased |

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
- 执行方式见 TASK-08 / `operations.md` §4（0.13.2 起写 `<DSH_HOME>/.env`，见 ADR-015）。因为要重启 DSH，执行前仍需用户确认时机。

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

## ADR-014 用环境变量移动影子目录

- **背景**：ADR-011 决定本机保留 `D:\DSH\shadow`。`operations.md` 原先的做法是在 profile patch 里覆盖 host 行和 `shadow-tools` 行，其中嵌套行一项标着"未经核验"。
- **核验结果**（rc.3 `dsh-app-boot` 的 `applyEntryPatches`）：
  - patch 的 id 索引只收录顶层行和 `group` 行的子行。`shadow-tools` 在 `preset-shadow.config.plugins` 里，不是 group，打不中，加载器只打一条 `entry not found` 警告。
  - 非 insert 的 patch 对目标行的字段做**整体赋值**：覆盖 host 行的 `config` 会丢掉 `shadowPresetId`；覆盖 `preset-shadow` 的 `config` 会把整份 preset 冻结在 profile 里，插件以后对 preset 的修改全部被遮住。
- **决策**：两行的 `shadowDir` 表达式都改为 `process.env.DSH_SHADOW_DIR || <home>/dsh-shadow`。一个环境变量同时决定 host、tools、client 三处，profile patch 不再需要碰影子。空字符串视为未设置。
- **后果**：环境变量在 DSH 进程启动时读取，改完必须完全重启 DSH。ADR-011 的执行方式改为 `operations.md` §4。
- **测试**：TC-PATCH-007（未设置时回落到默认值）、TC-PATCH-010（设置后两行同时生效，空值回落）。
## ADR-015 用 `<DSH_HOME>/.env` 里的 `SHADOW_DIR`

- **背景**：0.13.1 按 ADR-014 用 `setx DSH_SHADOW_DIR` 设置用户环境变量。完全重启后宿主日志仍是 `shadow: directory C:\Users\25313\dsh-shadow`：新的 DSH 进程没有继承这个变量（它的父进程不是重新读取了注册表的 Explorer）。系统环境变量要靠"由谁启动 DSH"才能传到，不可靠。
- **核验**（rc.3 源码）：桌面宿主 `lib/host.js` 启动时调用 `dsh-app-boot` 的 `loadLayeredEnv`，按"已继承的进程环境 > 当前目录 `.env` > `<DSH_HOME>/.env`"合并，已有的变量不覆盖。但 `isBootstrapOnly` 拒绝 `.env` 里以 `DSH_`、`XDG_`、`DYLD_`、`BASH_FUNC_` 开头的变量，**而且是抛错，DSH 会起不来**。所以 `DSH_SHADOW_DIR` 不能写进 `.env`。
- **决策**：两行改读 `process.env.SHADOW_DIR`。设置方式写进 `<DSH_HOME>/.env`（本机 `D:\DSH\.DSH\.env`），它随 DSH 数据目录走，不依赖怎样启动 DSH。进程环境里的同名变量优先。
- **防回退**：TC-PATCH-011 检查表达式只读一个变量，且不以上述前缀开头。
- **测试**：TC-PATCH-007、010、011；端到端 TC-E2E-002。
## ADR-016 浏览器半边不依赖行配置

- **问题**：侧栏"影子"入口点了没反应。宿主日志：`create failed Error: no shadowDir configured on the plugin row`。
- **根因**：**DSH 插件行的 `config` 从来到不了浏览器半边。**三处 rc.3 源码互证：
  1. `dsh-client-modules/lib/client.js` 的 `create()` 用 `const options = { name: id }` 建条目；
  2. 启动清单 `parseBootManifest` 只解析 `{id, url, rev, inject, external, immediately}`；
  3. `graphRow()` 只从 `dsh.client` 声明取 `inject/immediately/external`，而该声明没有 config 字段。
  
  官方带浏览器半边的插件（`dsh-client-ui-*`）的 `apply(ctx)` 因此都不读 config。我们的 `client.js` 从 v0.1.0 起就假设配置能到，于是 `shadowDir` 一直是空字符串：面板列不出会话，也建不了会话。
- **决策**：影子工作区改由**它自己的会话**识别。工作区的 `sessionIds` 在宿主侧已按 cwd 过滤，所以"装着用影子预设创建的会话的工作区"，其 path 就是影子目录。`lib/client.js` 的 `findShadowWorkspace()` 挑影子会话最多的那个（并列取注册顺序第一个，结果确定）；归档的会话不计入。创建新会话时复用这个工作区，不再走 adopt 路径。
- **全新安装**（一个影子会话都没有）：浏览器无法向宿主要目录，面板显示"请先用影子预设新建一个对话"，并让用户用官方 preset 选择器建第一个。之后入口即可用。
- **host 半边不变**：仍从行配置读 `shadowDir`，那是它唯一的真相来源。
- **测试**：TC-CLIENT-012 至 015（含"别的预设不算""归档不算"）；TC-CLIENT-003 不再断言 `shadowDir` 出现在 slot 上。

---

## ADR-017 归档影子不抹掉工作区身份

- **触发**：2026-11-07 用户要求恢复入口，并报告“新建影子对话”无反应。真实 renderer 显示所有影子主会话均已归档；旧算法忽略它们后无法发现原工作区。
- **决策**：保留 ADR-016 的会话发现方式，但只统计主会话；优先未归档影子主会话，没有时允许归档影子主会话提供原工作区身份。列表仍隐藏归档会话，新建沿用该工作区，不恢复旧对话、不让子代理指定新建目标。
- **界面**：除恰好一个可见影子时直接打开外，先打开面板，明确展示加载、空态及错误；新建只由新建按钮触发。
- **验证**：TC-CLIENT-015、018 至 020；本机通过入口新建并打开影子对话。

## ADR-018 投递归因采用明确回合边界

- 可选 deliveryMessageId 使用现有 messageId，不改变发送/幂等。inbox → exact user/message → enclosing turn/start/end 才能关联；缺少证据则 pending/uncertain。一轮多输入标 shared，不宣称唯一归因。next-step 新输入也算共享。
- 旧 replyAfterSeq 保留为范围内最新回复视图；旧结束事件不再被新回复借用。执行结束不能代表验收。
- 来源为静态 rc.3 dsh-agent-loop 代码与已有运行时事件规格；无真实投递测试。

## 未决问题

| # | 问题 | 选项 | 建议 | 决策人 |
|---|---|---|---|---|
| Q1 | ~~子代理是否固定完全权限~~ | | 已决：ADR-009 | |
| Q2 | ~~本机影子目录~~ | | 已决：ADR-011 | |
| Q3 | 跨影子实例对同一目标的竞态是否需要测试？ | (a) 在仿真里加两个 tools 实例共享一个 world；(b) 维持论证 | (a)，成本低 | 维护者 |
| Q4 | ~~发布渠道~~ | | 已决：ADR-010 | |
| Q5 | "已确认监管项目"清单目前手写在影子工作目录的 `REGISTRY.md`，是否需要工具化？ | (a) 维持手写；(b) 独立账本插件（ADR-003） | 先 (a)，有 3 个以上项目再评估 | 用户 |
