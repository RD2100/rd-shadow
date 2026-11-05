# 运维手册（维护者）

本文的操作会改动正在运行的 DSH。便宜模型与自动化代理**不得**执行（`AGENTS.md` §3）。

## 1. 安装

| profile | 方式 |
|---|---|
| desktop | 应用内插件页，或让 agent 调 `plugin_manager` 的 `install_bundle spec=<checkout 路径>`（desktop profile 不能用 `dsh plugin` 命令行） |
| web / tui | `dsh plugin --profile web add <checkout 路径或 Git URL>` |
| 手动 | profile `package.json`：`dsh.profile.bundles` 加 `dsh-plugin-shadow`，`dependencies` 加 `"dsh-plugin-shadow": "file:<checkout 路径>"` |

本机现状：`D:\DSH\.DSH\profiles\desktop`，依赖为 `file:D:/DSH/shadow-plugin`（复制安装，不是链接）。

## 2. 同步与核对

```sh
node tests/run.mjs                                   # 1. 离线全绿
node scripts/sync.mjs --profile D:/DSH/.DSH/profiles/desktop   # 2. 复制 lib → package.json → patch，并跑 --deployed
node scripts/fingerprint.mjs                         # 3. 记下期望构建戳
# 4. 重启 DSH（HMR 不监视 lib/*.js）
# 5. 执行 test-cases.md 的 TC-E2E-002
```

`sync.mjs` 最后复制 `cordis.patch.yml`，避免热重载看到"新入口 + 旧兄弟模块"。重启和重启后核对也可以交给 `dsh-plugin-restart` 仓库的 `node scripts/verify-and-restart.mjs --repo <checkout>`；它会中断宿主里正在跑的任务，必须作为一轮操作的最后一步。

## 3. 故障判读

| 日志 | 含义 | 处理 |
|---|---|---|
| `SyntaxError: … does not provide an export named …` + `did not activate` | 热重载复用了旧模块图 | 重启 DSH |
| `shadow: this runtime lacks …` | 宿主版本与 rc.3 不符 | 不要继续使用；按 `detailed-design.md` §7 复核契约 |
| `shadow: build <hash>` 与 fingerprint 不同 | 宿主跑的是旧副本 | 重新 sync 并重启 |
| `shadow: directory <路径>` 不是你期望的目录 | profile 未覆盖 `shadowDir` | §4 |
| 影子会话里没有 `shadow_*` 工具 | 会话不在 `shadowDir`，或 preset 不是 `shadow` | 检查会话 cwd 与 preset |

## 4. 本机修复：保留 `D:\DSH\shadow` 作为影子目录（TASK-08）

现状（2026-11-06 核对）：宿主日志为 `shadow: directory C:\Users\25313\dsh-shadow`，该目录不存在；真正的影子工作区是 `D:\DSH\shadow`（20 个会话）。

**需用户批准后执行。** 先备份 `D:\DSH\.DSH\profiles\desktop\cordis.patch.yml`，再在末尾追加 host 行覆盖（已知可行：profile patch 按 id 覆盖顶层行的 `config`）：

```yaml
# 影子插件：保留 0.11.0 之前的影子目录（host 行与 shadow-tools 行必须一致）
- id: shadow
  config:
    shadowDir: 'D:\DSH\shadow'
```

`shadow-tools` 行嵌在 `preset-shadow` 的 `plugins` 列表里。**profile patch 如何覆盖嵌套行未经核验**，按顺序尝试：

1. 顶层按 id 覆盖：`- id: shadow-tools` + `config.shadowDir: 'D:\DSH\shadow'`；
2. 若无效，在 Web 设置页编辑影子 preset，把 `shadow-tools` 行的 `shadowDir` 改为同一路径（编辑器会把整份 `config.plugins` 写进 profile patch，见 `cordis.patch.yml` 顶部注释）。

**核验方法**：重启后在影子目录的会话里调用 `shadow_targets`。若返回 `not-shadow (this Session (D:\DSH\shadow) is not the shadow)`，说明 host 行生效而 tools 行没有。

然后执行 TC-E2E-002（期望 `shadow: directory D:\DSH\shadow`）和 TC-E2E-003。

## 5. 发布清单

1. `SHADOW_STRICT_TODO=1 node tests/run.mjs` 通过（无 todo 遗留），或在 CHANGELOG 中说明保留的 todo
2. 在没有沙箱限制的终端里 `node scripts/pack-check.mjs` 通过
3. `package.json` 版本、`CHANGELOG.md` 的 Unreleased 改为版本号与日期、`lib/index.js` 的 `EXPECTED_RUNTIME` 是否需要更新
4. `git tag v<版本>`，推送分支与 tag
5. npm 发布取决于未决问题 Q4
