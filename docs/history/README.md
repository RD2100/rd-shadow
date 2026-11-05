# 历史档案（不是实现依据）

这些文件记录 0.2.0 至 0.11.0 的设计推演、运行时核验、端到端实测和事故复盘。它们解释"为什么现在是这样"，但其中大量机制已删除：

| 文件 | 内容 | 当前状态 |
|---|---|---|
| `DESIGN.md` | v1 设计：不变量、`auto` + auto-review 权限模型、里程碑 M1–M4 | 不变量仍有效（已并入 `../overview-design.md` §3）；权限模型已被 ADR-001 取代 |
| `DISPATCH-SPEC.md` | M3 调遣实现规格与实测记录 | 状态机与宿主契约已并入 `../detailed-design.md`；§8、§11.9–§11.12 描述的审批与守卫已删除 |
| `DISPATCH-ABSORPTION.md` | 旧 workbench 源码核验与移植边界 | 仅供考古 |
| `E2E-GUARD.md` | 出网守卫端到端验证、重启裁判、热换、续接 | 守卫已删除（ADR-004）；重启相关迁至 `dsh-plugin-restart` 仓库 |
| `SELFTEST.md` | 影子自检提示词（`auto` 时代） | 已过时 |
| `PROBES.md` | 出网守卫实测探针 | 已过时 |

被删除的出网分类器源码与 fuzz 测试保留在 tag `archive/egress-classifier`。
