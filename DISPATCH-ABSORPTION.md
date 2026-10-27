# 旧源码核验与吸收：调遣链路（M3）与权限边界（M4）

版本：v1。日期：2026-10-27。
本文是 [DESIGN.md](DESIGN.md) 的配套核验记录：把 `dsh-workbench` 旧包中影子调遣链路的**代码事实**逐条验证固化，作为移植到本插件的依据。所有结论均来自只读源码与运行时产物的行号证据；旧代码未被修改。

核验范围：
- 旧实现：`D:\DSH\dsh-workbench\packages\workflow\workbench\src\`（session-control、orchestration、shadow-entry、work-data、shared、组装层）
- 旧测试：同包 `tests/` 下 4 个文件共 38 个用例
- 运行时：`C:\Program Files\DSH NEXT\resources\app.asar`（rc.3 编译产物与 README）
- 当前部署：`D:\DSH\.DSH\profiles\desktop\`（bundles 与宿主日志）

---

## 1. 模块地图

| 模块 | 文件 | 职责（一句话） |
|---|---|---|
| 会话控制 | `host/session-control/index.ts`(205) | 投递/观察/创建的官方适配层，含每目标会话的串行队列 |
| 会话控制类型 | `host/session-control/types.ts`(94) | `ContinueReceipt`/`DeliveryEvidence`/`CreateReceipt` 等回执合约 |
| 创建 | `host/session-control/creation.ts`(105) | 确定性身份创建与只读恢复，不确定时保留身份 |
| 证据 | `host/session-control/evidence.ts`(53) | 从会话日志扫描「原始投递 + 第一条 admitted 它的模型请求」 |
| 编排 | `host/orchestration/index.ts`(335) | 薄协调器：身份→授权→预留→中继→回执 |
| 编排类型 | `host/orchestration/types.ts`(152) | 工具请求/端口/回执合约；`OrchestrationPorts` 含必填 `workData` |
| 中继 | `host/orchestration/relay.ts`(44) | 确定性冻结中继信封（eventId/attemptId/messageId 派生） |
| 身份 | `host/orchestration/identity.ts`(99) | 从会话日志验证原始工具调用，派生稳定通信身份 |
| 授权 | `host/orchestration/authority.ts`(67) | 复用 Host 审批，按 request 对象缓存 allowed-once |
| 工具面 | `host/orchestration/tools.ts`(148) | 6 个模型可见工具 + 系统提示段（`interpolate:false`） |
| 影子入口 | `host/shadow-entry/index.ts`(241) | 候选发现、显式选择、首次创建、绑定守卫 |
| 选择存储 | `host/shadow-entry/selection.ts`(33) | 官方 Settings volatile 字段桥（单一存储） |
| 账本 | `host/work-data/*`(约 900 行) | **本插件不移植**（DESIGN §6） |
| 组装 | `src/index.ts`(678) | Service 类插件 `Workbench extends TypertRemoteService`，21 个 `@Remote` 方法 |

---

## 2. M3-投递：已验证的状态机

`continueSession`（session-control/index.ts）是投递的唯一入口，一次调用按序执行：

1. **串行化**：`active: Map<SessionId, Promise<ContinueReceipt>>`——同目标会话的并发投递链式等待，不交错（L32）。
2. **发送者校验**：`requireSender` 要求实际发起 Agent 存在、不是目标本身、且 `message.source` 恰为 `{kind:'agent-message', form:'relay', senderSessionId}`，否则 `sender-mismatch`。
3. **授权复查**：`authorize()` 在四个边界被调用（进入、模型校验后、resolveAgent 后、发送前），每次先查 signal 与发送者身份。
4. **先观察**：`observeDelivery` 先扫目标日志——**同一 messageId 已在 inbox 即返回 `already-delivered`**（幂等第一道闸，不依赖账本）。
5. **状态准入**：`inspectTarget` 要求 `idle` 或 `cold`；`busy/archived/paused/blocked/pending/waiting-user/subagent/unknown` 以该状态码本身拒绝，且 `selected=null`。
6. **模型校验**：对真实 catalog 校验，失败 `model-unavailable`，不落 selection、不投递。
7. **活性硬校验**：`liveReady` 逐一核对 agent/session 身份、非归档、workspace 成员、`agent.status==='idle'`、inbox 为空、`agent.session.seq - 1 === expectedSeq`——任一不符 `session-changed`/`session-detached`。
8. **选择模型**：`selectModel`（旧注释明确「This operation never saves the default model」——rc.3 下见 §7 分歧 2）。
9. **发送**：`agent.send(message, 'next-turn', true)`，随后 `sessions.flush`。
10. **取证**：再次 `observeDelivery`——证据为 null → `unknown`；已持久化 → `durable`；仅插入 → `accepted`。
11. **失败归类**：`sent ? 'unknown' : 'rejected'`。发送后任何异常都不得声称没发送。

`observeDelivery` 只读、不激活、不发送；`evidence.ts` 的扫描算法：`agent/inbox/spliced` 中按 messageId 深比较定位 `inboxSeq`（内容不符抛 `message-identity-conflict`）；`user/message` 同 id 定位 `userSeq`；其后的第一个 `request/header` 记为 execution 选择；`assistant/message` 或 `assistant/attempt` 置 `settled:true`；`step/end`/`turn/end` 终止扫描。

`inspectTarget`（冷安全观察）：无 agent → `cold`；running → `busy`；subagent origin 或非 root → `subagent`；已归档 → `archived`；缺 inbox/modelSelection/goal 投影或 goal 日志重放失败 → `unknown`（**准入用严格日志重放，不用显示投影**）；有待办用户问题或未决审批 → `waiting-user`；inbox 有条目 → `pending`。

## 3. M3-幂等：键的派生与无账本化论证

### 3.1 旧的键体系（两层）

| 键 | 派生 | 位置 |
|---|---|---|
| `communicationId` | sha256(sessionId, messageId, blockIndex, subCallId)，来自日志中验证过的原始 tool-call 块 | identity.ts:96-99 |
| `attemptId` | `attempt-${identity.id}` | relay.ts:41 |
| `eventId` | `${identity.id}:prepared` / `${identity.id}:observed` | relay.ts:40、index.ts:160 |
| `messageId` | `workbench-message-${sha256(identity.id, workId, workspaceId, sessionId, senderSessionId, provider, model, reasoningEffort, content)}` | relay.ts:30-36 |

身份验证（identity.ts）绑定内容：`execution.arguments` 必须与日志中持久调用的 arguments 深相等（L59/L76-78），PTC 子调用还必须匹配唯一的 `tool/ptc-dispatch-start`（L80-89）。**因此同一通信身份必然携带同一份内容**——「同键不同内容」在身份层即不可能，账本的 `event-id-conflict` 只是第二道防线。

### 3.2 账本提供的、无账本后需要替代来源的两条保证

f8b75c42 的核验指出 `dispatch-already-linked`（全表扫描同 (sessionId, messageId) 不得双关联）与 `ambiguous-turn`（跨 work 轮次争用）都依赖账本全表扫描。评估：

- **dispatch-already-linked** → 由 messageId 确定性 + `observeDelivery` 先扫 + `active` Map 串行化共同覆盖：同一次原始调用的重放得到同一 messageId，inbox 扫描命中即 `already-delivered`；不同原始调用得到不同 messageId，本就是不同消息。`agent/inbox/spliced` 是 append 语义，同一消息不会被插入两次。
- **ambiguous-turn** → 属执行归属登记（哪一轮属于哪个 attempt），与投递正确性无关，随账本一起裁掉；影子插件不声明 attempt 归属。

**结论：无账本移植不损失 DESIGN §5.3 要求的幂等性。** 最小保留集 = 身份验证（identity.ts 的判断）+ 确定性中继派生（relay.ts 的判断）+ 证据扫描（evidence.ts 全文）+ 串行队列（active Map）。

## 4. M3-回执：状态机与「不声称没发送」

`ContinueReceipt`：`status: accepted | durable | already-delivered | rejected | unknown`，`selected: ModelSelection|null`（**选择已提交即如实带回执，即使投递被拒**——测试 #11 证明），`evidence`，`reason?`。

`OrchestrationDeliveryResult`：`delivery`（上述回执）+ `recording: 'recorded'|'unknown'`（账本提交本身是否确认）+ `modelMismatch`（实际请求证据与请求 selection 不符即置位，「never silently switch it back」）。

「不声称没发送」在代码中的三处体现（均有注释原话）：
- `delegate` 对 `continueSession` 的 catch：`receipt = unknownDelivery(...)`——「Unexpected rejection cannot prove no send occurred.」（index.ts:157）
- `recordDelivery` 的 catch：`recording = 'unknown'`——「The send may have committed; retain its identity and receipt, never replay it to repair accounting.」（index.ts:119）
- `observe` 的 catch：保留原 attempt 待显式调停——「Read failure preserves the original attempt for a later explicit reconciliation.」（index.ts:97）

无账本后 `recording` 字段消失（无账本可记），但 `delivery` 的五态与证据原样保留；调停（reconcile）退化为对同一消息的只读 `observeDelivery`——**同一原始调用的重放本来就该走 already-delivered 分支，不需要单独的 reconcile 工具**。

## 5. M4-权限边界：旧做法的否定与现机制的确认

### 5.1 旧实现的做法（已被 DESIGN §3.2 否定）

- 创建时一次性套用 `newShadowPermissionPreset`（部署值 `danger-full-access`），校验 `bundle.sandbox==='danger-full-access' && bundle.approval==='never'` 后 `permissions.set` 并回读（src/index.ts:562-600）。
- 每次操作前 `createApprovalAuthorizer` 复核：调用者是 root、是当前选中影子；`fullAccess()` 三条件（预设在 names 内、bundle 为 danger-full-access+never、sandboxPolicy 模式为 danger-full-access）命中则跳过审批，否则 `ctx.approval.request`，仅 `allowed-once` 通过（authority.ts:26-66）。
- 只有 `delegate`/`create-owner`/`memory-write` 进审批门；replay 时 operation 改判 `reconcile` 避免重复要审批（index.ts:132-133）。
- authority.ts:41-42 的注释明确意识到 Auto：「Auto may retain its identity with a never knob, but its official bundle is ask.」——即旧代码下 Auto 会话的每次调遣都会问用户。

**没有任何可逆性分级代码。** 旧实现靠「Full access + never」让影子全速运行；新设计否定了 `never`（会在应答者链之前拒绝一切，包括正常调遣）。

### 5.2 新设计的机制（已在本部署生效）

证据链（全部实测）：
1. `D:\DSH\.DSH\profiles\desktop\package.json:11` 的 bundles 含 `@deepseek-ai/dsh-experimental-auto-review`。
2. 该插件 effect 内调 `permissionPresets.registerAuto(...)`——**`auto` 预设名仅在其挂载时存在**（asar 内 `dsh-experimental-auto-review/lib/index.js`）。
3. 宿主日志 `shadow: <sessionId> permission -> auto`——本插件 host 半边按 `names.includes('auto')` 选择并落盘，证明评审在位。
4. `AUTO_PRESET_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }`（asar 内 `dsh-permission-presets`）。
5. 评审判定策略（`REVIEW_POLICY` 原文）与 DESIGN §3.4/§3.5 逐条对应：low（项目内普通读写/分析/非破坏 Git/本会话自建对象的精确清理）直接放行；medium（不可逆删除既有对象、强推或历史重写、生产读写部署、非敏感对外写入、权限/安全控制变更）须人或直接父级明确授权动作、目标与范围；high（跨信任边界泄露敏感信息）一律拒，即使有人明确要求。效果不明确或授权冲突未解决 → 拒（fail closed）。
6. 两道闸门即 DESIGN §3.3 的表：pre-execute listener（执行前判定）+ `ask` 策略把拒绝路由给用户（审批应答）。`approval.request` 落 `approval/asked`+`approval/decided` 审计对，模型可见即日志可见。

### 5.3 M4 的剩余工作

- **端到端验证未做**：旧测试对不可逆审批**零覆盖**（bd61ea96 核验确认）；需要一次真实触发（影子尝试删除已存在文件/访问生产）观察审批出现且 body 未执行。
- **已知缺口**（auto-review README「已知限制」）：PTC 程序内直接 Node 效果不经 inner-tool review；分级是模型判断、会误判；无确定性豁免与持久 grant。
- **与 authority.ts 的叠加**：若移植时保留 authority.ts 的门，auto 会话的每次 delegate 都会问用户（fullAccess 恒 false）。是否叠加见 §9 开放问题 3。

## 6. 不变量与失败语义：旧代码位置 ↔ 测试证据

DESIGN §2 五条不变量在旧代码中的落点与测试（编号见 bd61ea96 报告）：

| 不变量 | 代码落点 | 测试证据 |
|---|---|---|
| 选择只来自显式动作 | shadow-entry `select`/`createFirst` 需 authorize；快照只读 | shadow-entry #1/#3/#4/#5/#10；sc #13/#14 |
| 冷会话选中仍冷 | 快照/select 不 resolveAgent；仅官方 resume 后 bindAgent | shadow-entry #2/#11/#12/#13；sc #18；persistence e2e |
| 三锚点身份 | `sameChoice`(version/sessionId/createdAt/presetId/cwd) + `selectedIdentity` 六种 issue | shadow-entry #12（6 例）/ #13 / #11 |
| 一份选择只存一处 | Settings volatile 单字段，无第二存储域 | persistence e2e（设置补丁逐字节不变）；#11/#14/#15 |
| 模型可见即日志可见 | identity.ts 只认日志中的原始调用；relay 消息以 agent-message 源落盘 | sc #7；composition e2e（完整日志比对） |

DESIGN §5 四条失败语义的代码落点：不静默降级（权限套用失败回 `unknown` + 可见 reason；发现失败永不变成创建许可——shadow-entry #7）；不吞异常（`SessionControlError`/`OrchestrationError` code 化，编程错误上抛）；投递不重复（§3）；回执保留（§4）。

## 7. rc.3 运行时 API 核验（DESIGN §9 要求）

### 7.1 已确认可用

| 接口 | 位置 | 结论 |
|---|---|---|
| `agent.send(message, 'next-turn', wakeup)` | asar `dsh-agent-loop/lib/index.js:800` | **与旧代码用法一致**；`followup(input)` 即其封装；splice 产生 `agent/inbox/spliced` |
| `approval.request({agent, toolName, callId?, reason?, signal?})` | asar `dsh-user-approval/lib/index.js:128` | 一致；`allowed-once` 是唯一 grant；需开着的 turn；落审计对 |
| `permissionPresets.names/current/resolve/set/registerAuto` | asar `dsh-permission-presets/lib/index.js` | 一致 |
| 服务面齐全 | base+web-app bundles 依赖表 | `dsh-agent`、`dsh-session`、`dsh-session-query-sqlite`、`dsh-user-approval`、`dsh-permission-presets`、`dsh-sandbox-policy`、`dsh-workspace`、`dsh-api-session-controller`、`dsh-agent-preset-registry`、`dsh-subagent`、`dsh-storage-domain` 全部在位 |

### 7.2 三处关键分歧（影响移植设计）

**分歧 1：`creationMode: 'new-only'` 不存在。**
rc.3 `sessionController.create(request)` 只接受 `{sessionId?, workspaceId|cwd, agentPreset?}`（asar `dsh-api-session-controller/lib/index.js:755`）。命名 sessionId 的复用规则（同包 README.zh.md L44）：仍为空白（无 `turn/start`）、属于请求目录、是请求工作区未归档成员、未被其他写者占用 → 复用；否则**用该 id 新建**；同 id 请求按到达顺序串行（`inOrder`）。指其他目录的会话 → `session/conflict`；subagent 路由拥有的 → `session/agent-busy`。
→ 确定性身份创建模式仍可行（首调用即得该 id；重放复用空白会话即恢复），但**「已开始轮次或不归属」时 rc.3 静默 mint 不同 session**，移植方必须自检 `created.sessionId === derivedId`，不符走 `unknown`/`creation-id-mismatch`，绝不把新 session 当作稳定身份。

**分歧 2：`selectModel` 会保存默认模型。**
rc.3 `sessionController.selectModel` JSDoc 原话：「save the default in the background」（`lib/index.js:789`），实现调 `agentDefaultModel.saveSelection`。旧测试 #7 断言「不写默认模型」无法经此 API 满足。只 append `model/selection` 事件的 `selectForNextRequest` 在包内私有类 `ApiSessionAgentController` 上，插件不可达。
→ 见 §9 开放问题 2。

**分歧 3：官方 prompt 去重 vs 中继消息源。**
rc.3 `prompt(request, source)` 有官方 requestId 去重：`hasPromptRequest(agent, requestId)` 命中即返回 `{accepted:true}` 不重复插入（`lib/index.js:927`）；但消息 source 是 `user-rpc`（kind `user` + rpcId），**不带 senderSessionId**。旧实现的 `agent-message`/`relay` 源保留发送者归属但无官方去重（去重靠 messageId + 日志扫描）。
→ 见 §9 开放问题 1。

## 8. 移植边界

### 8.1 可直接继承的判断（DESIGN §4/§7 允许继承判断，不复制源文件）

- shadow-entry 的选择不变量全套判断（候选过滤、三锚点、issue 矩阵、绑定守卫、归档可见不可选）
- selection.ts 的单一存储桥（改官方 Settings 字段名即可）
- continueSession 的状态机、拒绝码表、授权四边界、liveReady 硬校验
- evidence.ts 的扫描算法全文
- relay.ts 的确定性派生公式
- identity.ts 的身份验证判断（只认日志原始调用）
- unknownDelivery / recording / modelMismatch 的失败语义
- authority.ts 的「每次边界重查 + request 对象级 allowed-once 缓存」模式（门的内容需按 §9 问题 3 重新决策）

### 8.2 需按官方接口重写（DESIGN §7 明示）

- **创建会话**：creation.ts 的 create 调用按 §7.2 分歧 1 重写（无 new-only；自检 id 一致性；处理 conflict/agent-busy）
- **工具绑定**：registerOrchestrationTools 的注册机制按 rc.3 重写；工具集从 6 个裁到调遣所需最小集
- **回执面**：`recording` 随账本消失；`OrchestrationDeliveryResult` 简化为 delivery + modelMismatch

### 8.3 明确不移植

work-data 全域（schema/records/store/projections）、memory、subscriptions/pools、usage/context、sessionManagement、portfolio fold、`workbench_query` 的 work/portfolio 分支。

## 9. 决策记录（2026-10-27 用户确认）

1. **投递消息源 = 中继源 + 自建去重。** 投递消息带 `source: {kind:'agent-message', form:'relay', senderSessionId}`，目标会话日志可重建发送者归属；幂等靠确定性 messageId + 投递前扫日志（§3.2 已论证无账本下无损）。不采用 rc.3 的 `user-rpc`+requestId（丢失归属）。
2. **模型选择 = 走官方 API，接受副作用。** delegate 带 selection，走 `sessionController.selectModel`；接受「同时保存全局默认模型」这一 rc.3 既定行为，在工具描述与回执里如实呈现，不伪装。
3. **审批门 = 只留绑定检查，判定交给 auto-review。** 每次边界仍校验「调用者是当前选中的影子」（绑定失效即拒），但移除 authority.ts 的审批询问；可逆性判定完全由 auto-review 的 pre-execute listener 承担（DESIGN §3.3/§3.4 的分工）。旧 authority.ts 的 `fullAccess`/`answers`/`approval.request` 三件套不移植。
4. **DESIGN §5.3 语义 = 换目标即新消息。** 同一协调者+同一目标+同一内容 = 判重拒绝；换目标会话 = 新消息照投。DESIGN.md §5.3 措辞已按此修订（原文末句「换目标会话或换工作项都不构成新消息」与键定义矛盾，已改为「键相同的重投判重拒绝；换目标会话即是新消息」）。无账本后「工作项」不参与键。
5. **投递目标范围 = 不限制。** 影子可调遣任何已注册工作区中的会话，delegate 显式命名 `(workspaceId, sessionId)`；宿主保留成员关系校验作为**正确性护栏**（防指错工作区），不是权限限制。
   - 重要边界：**范围无限制 ≠ 状态无门槛。** continueSession 的准入状态机原样保留——`busy/archived/paused/blocked/pending/waiting-user/subagent/unknown` 的目标仍然拒收（这是「此刻能不能收」的事实判定，不是「允不允许派」的权限判定），拒绝时带回可见 reason，不静默丢弃。
   - 与决策 3 合成完整的权限图景：目标随便选，但只有 auto-review 判 low 的操作自动执行；medium 问用户；high 拒绝。

### 9.1 DESIGN §5.3 澄清过程记录（已决）

原文：「投递不重复。幂等键必须覆盖『同一个协调者 + 同一个目标会话 + 同一份内容』，而不是只按会话判断。换目标会话或换工作项都不构成新消息。」

歧义在最后一句：前半句要求键**包含**目标会话（换目标 = 不同键 = 新消息），末句却说换目标「不构成新消息」（换目标 = 同一键 = 判重）。具体后果：

- 影子给会话 A 发「查一下构建为什么失败」→ 成功；
- 影子给会话 B 发同一句话 → 按旧代码行为：**新消息，照投**；按末句字面：**判重，拒投**。

按字面执行的后果是影子无法把同一份指令发给两个执行会话（第二次被幂等挡掉），与「跨项目监督」的用途相悖。旧代码行为（messageId digest 含 sessionId）更合理。

另注意：无账本移植后「工作项」概念不复存在（digest 本就只含协调者+目标+内容），换工作项那半句自动失去意义；真正要定的只剩「换目标会话」这一半。

## 10. 下一步

1. ~~用户就 §9 五问给出决策~~ → **已完成（2026-10-27 全部锁定，见 §9）。**
2. 写 M3 实现规格（工具面 + 状态机 + 回执 + 测试清单）：测试规格沿用 bd61ea96 报告的 38 条中与调遣/选择相关的部分，按「独立插件 + 官方 runtime」重写组装；两个旧 integration e2e 的断言机制（完整持久化日志比对 + expected pin）可直接沿用，快照需在新插件名下重录。
3. M4 端到端验证：让影子尝试一次不可逆操作，确认审批出现且 body 未执行（需桌面端配合）。

---

## 附：核验方法与产物

- 四路并行只读核验（work-data 合约 / orchestration 工具面与身份 / 服务组装 / 测试行为规格），全部报告已并入本文。
- 运行时 API 从 asar 编译产物（JSDoc 即类型来源）与包内 README.zh.md 读出。
- 工具资产：`D:\DSH\.tmp-inherit\`（asar-read.mjs、asar-files.mjs 等）。
- 全程只读；未修改 `dsh-workbench` 与运行时任何文件。
