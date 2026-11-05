# 文档地图

| 文档 | 读者 | 回答什么问题 |
|---|---|---|
| [../AGENTS.md](../AGENTS.md) | 实现者（人/模型） | 能改什么、不能改什么、做卡片的流程 |
| [overview-design.md](overview-design.md) | 所有人 | 影子是什么、边界在哪、由哪些部分组成、关键流程 |
| [detailed-design.md](detailed-design.md) | 实现者 | 每个模块的职责与接口、状态机、拒绝码、输出格式、宿主契约 |
| [test-cases.md](test-cases.md) | 实现者、评审 | 测试策略、用例编号规则、待实现与手工用例规格、全量索引 |
| [decisions.md](decisions.md) | 维护者 | 已做的架构决策及理由、未决问题 |
| [tasks.md](tasks.md) | 实现者 | 可直接领取的任务卡 |
| [operations.md](operations.md) | 维护者 | 安装、同步、重启、核对、本机修复 |
| [history/](history/README.md) | 考古 | 0.2–0.11 的设计、实测与事故记录；**不是实现依据** |

维护规则：

- 行为变了，先改 `detailed-design.md`，再改代码，再改测试。
- 新决策写进 `decisions.md`（ADR 编号只增不改）；推翻旧决策时新写一条并在旧条目标注 Superseded。
- 文档里的数字（用例数、文件行数）不要手写，引用生成结果或命令。
