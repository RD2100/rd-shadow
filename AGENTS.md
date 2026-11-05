# AGENTS.md：给实现者（人或模型）的工作规则

本仓库是 DSH 插件 `dsh-plugin-shadow`（影子总控）。本文件是**强制规则**；与其他文档冲突时以本文件为准，然后是 `docs/detailed-design.md`。

## 1. 先读什么（按顺序，不要跳）

1. `docs/README.md`：文档地图（2 分钟）
2. `docs/tasks.md` 里你要做的那张任务卡（**只做卡上写的事**）
3. 卡片引用的 `docs/detailed-design.md` 章节
4. 卡片引用的测试用例规格（`docs/test-cases.md` 第 3 节）

`docs/history/` 是历史档案，**不要**从里面取实现依据；它描述的审批 hook、出网守卫、重启 worker 都已删除。

## 2. 硬规则（违反任何一条，CI 或 review 都会拒）

| # | 规则 | 由谁强制 |
|---|---|---|
| R1 | 只改任务卡「允许修改的文件」里列出的文件 | review |
| R2 | 模块分层不可跨越：`core-*` 只能 import `core-*` 和 `node:crypto`/`node:util`；`op-*` 只能 import `core-*`；只有 `op-dispatch.js` 可以调 `send`/`resolveAgent`/`selectModel` | `tests/arch.test.mjs` |
| R3 | `lib/` 单文件 ≤ 400 行（`client.js` 除外）；超了就按职责拆，并更新分层表 | `tests/arch.test.mjs` |
| R4 | 新增 `lib/*.js` 必须同时登记到 `tests/arch.test.mjs` 的 `LAYERS` 和 `docs/detailed-design.md` §2 | `tests/arch.test.mjs` |
| R5 | 每个测试用 `check('TC-<AREA>-<NNN>', '一句话行为', fn)`；id 全仓唯一，**不复用、不重排**已有编号 | `tests/harness.mjs`、`tests/tc-index.mjs` |
| R6 | 先测试后实现：把卡片上的 `todo(...)` 改成 `check(...)` 并写断言，看它失败，再写实现 | review |
| R7 | 改了测试就跑 `node tests/tc-index.mjs --write` 并把 `docs/test-cases.md` 里对应规格的 `状态` 改成 `auto` | `tests/tc-index.mjs` |
| R8 | `lib/` 里的 `TODO` 必须写成 `TODO(TASK-NN)`，且 NN 在 `docs/tasks.md` 里存在 | `tests/arch.test.mjs`、`tests/tc-index.mjs` |
| R9 | 模型可见文本（工具 description、`core-render.js` 的输出行、`REASON` 值）是契约；改动必须写进 `CHANGELOG.md` 的 Unreleased，并更新 `docs/detailed-design.md` §5/§6 | review |
| R10 | 不吞异常：只捕获可预期的业务失败并转成具名 reason；编程错误上抛 | review |
| R11 | 不新增 npm 依赖；不在 `package.json` 声明 `@deepseek-ai/*`（由 DSH loader 提供） | `scripts/pack-check.mjs` |

## 3. 禁止事项

- 不要修改 `D:\DSH\.DSH\` 或任何 DSH profile、不要运行 `scripts/sync.mjs`、不要重启 DSH。部署是维护者的事（`docs/operations.md`）。
- 不要向真实会话投递消息来"验证"。离线仿真 `tests/tools-sim.mjs` 就是验证手段。
- 不要手改 `docs/test-cases.md` 里 `TC-INDEX` 标记之间的内容（它是生成的）。
- 不要删除或改写 `docs/history/`。
- 不要恢复已删除的出网分类器/审批 hook（见 `docs/decisions.md` ADR-001、ADR-004）。
- 不要 `git push`、打 tag、改版本号；发布由维护者做。

## 4. 做一张任务卡的固定流程

```text
1. 读卡片 → 确认「允许修改的文件」「验收用例」
2. 在测试文件里把 todo('TC-…') 改成 check('TC-…', …, () => { 断言 })
3. node tests/run.mjs           # 新用例应当 FAIL，其他全部通过
4. 写实现（只在允许的文件里）
5. node tests/run.mjs           # 全部通过
6. node tests/tc-index.mjs --write；把规格的「状态」改为 auto
7. 若卡片要求：更新 CHANGELOG.md 的 Unreleased 和设计文档对应章节
8. node tests/run.mjs           # 再跑一遍，包括 tc-index
9. git commit -m "TASK-NN: <一句话>"
```

完成标准（Definition of Done）：第 8 步全绿；卡片「验收用例」全部是 `auto`；没有改动卡片之外的文件；`git diff` 里没有调试输出。

## 5. 什么时候停下来问，而不是猜

- 卡片要求与本文件或设计文档矛盾；
- 需要改的文件不在「允许修改的文件」里；
- 需要新增 `REASON` 码、改工具参数、改 `cordis.patch.yml`，而卡片没写；
- 测试在你改动前就已经失败；
- 你发现需要访问真实 DSH 宿主才能确认某个运行时形状。

停下时在提交说明或回复里写清：卡片号、卡在哪一步、你看到的事实、两个可选方案。

## 6. 常用命令

```sh
node tests/run.mjs                    # 全部离线检查（CI 跑的就是这个）
node tests/<suite>.mjs                # 单个套件；tools-sim 需要: node --import ./tests/register.mjs tests/tools-sim.mjs
SHADOW_VERBOSE=1 node tests/ops.test.mjs   # 打印每个通过的用例
SHADOW_STRICT_TODO=1 node tests/run.mjs    # 发布检查：任何 todo 都算失败
node tests/tc-index.mjs --write       # 重新生成用例索引
```
