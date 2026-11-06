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
| `Plugin dsh-plugin-shadow@… is incompatible with dsh …` | DSH 自动更新到了 `engines.dsh` 范围外的版本，加载器禁用了插件（ADR-013 第 1 层） | §5 |
| `shadow: runtime contract mismatch …` 或工具返回 `runtime-mismatch` | 范围内的版本改了插件读的字段（第 2 层） | §5；**不要**豁免，先修插件 |
| 影子会话里没有 `shadow_*` 工具 | 会话不在 `shadowDir`，或 preset 不是 `shadow` | 检查会话 cwd 与 preset |

## 4. 本机修复：保留 `D:\DSH\shadow` 作为影子目录（TASK-08）

现状（2026-11-06 核对）：宿主日志为 `shadow: directory C:\Users\25313\dsh-shadow`，该目录不存在；真正的影子工作区是 `D:\DSH\shadow`（20 个会话）。

**不要用 profile patch 改 `shadowDir`**（ADR-014）。已从 rc.3 加载器源码（`dsh-app-boot` 的 `applyEntryPatches`）核实：patch 只能按 id 命中顶层行和 group 里的行，`shadow-tools` 嵌在 `preset-shadow` 的 `plugins` 里，命中不了；覆盖 host 行的 `config` 是整体替换，会丢掉 `shadowPresetId`；覆盖整个 `preset-shadow` 会把 preset 冻结在 profile 里，插件以后改 preset 就不再生效。

从 0.13.2 起两行都先读 `SHADOW_DIR`（ADR-015）。步骤（**需用户批准；第 3 步会中断所有会话**）：

1. 在 DSH 数据目录的 `.env` 里加一行（文件不存在就新建；UTF-8，无 BOM）：
   ```text
   SHADOW_DIR=D:\DSH\shadow
   ```
   本机路径是 `D:\DSH\.DSH\.env`（即 `$DSH_HOME/.env`）。**不要**写 `DSH_` 开头的变量：DSH 会拒绝并且无法启动。
2. 把插件同步进 profile：
   ```sh
   node scripts/sync.mjs --profile D:/DSH/.DSH/profiles/desktop
   ```
3. 完全退出 DSH（包括托盘图标）后重新打开。
4. 核对：TC-E2E-002（期望 `shadow: directory D:\DSH\shadow`，build 哈希等于 `node scripts/fingerprint.mjs`）、TC-E2E-003、TC-E2E-004。

回退：删掉 `.env` 里那一行，完全重启 DSH，影子目录回到 `<home>/dsh-shadow`。

> 0.13.1 用过的 `setx DSH_SHADOW_DIR` 已不再被读取，可用 `reg delete HKCU\Environment /v DSH_SHADOW_DIR /f` 删除。
## 5. DSH 更新之后：复核与放宽版本范围

触发：§3 表里出现 `incompatible with dsh` 或 `runtime contract mismatch`，或你知道 DSH 刚更新过。

```sh
cd D:\DSH\shadow-plugin
node scripts/contract-probe.mjs --home D:\DSH\.DSH --limit 30 --asar "C:\Program Files\DSH NEXT\resources\app.asar"
```

输出第二行是已安装的运行时版本，之后每份日志一行 `ok` 或 `FAIL`。

| 结果 | 处理 |
|---|---|
| 版本在 `engines.dsh` 范围内，全部 `ok` | 插件能用。若出现过 `runtime-mismatch`，看它点名的是哪个服务方法，再按 `detailed-design.md` §7 核对 |
| 版本在范围外，全部 `ok` | 形状没变。按 `detailed-design.md` §7 的表逐项核对服务方法（用 asar 只读查看），确认后：改 `lib/core-contract.js` 的 `VERIFIED_RUNTIME` 与 `package.json` 的 `engines.dsh`（两者由 TC-RTC-006 绑定），跑 `node tests/run.mjs`，发布新版本 |
| 有 `FAIL` | 形状变了。按探针点名的字段更新 `core-shape.js`、相关 fold 和 `tests/tools-sim.mjs` 的替身，再更新 §7 |

**临时继续使用**（明知风险）：`dsh plugin allow-version`，或插件管理器里对 `dsh-plugin-shadow@<版本>` 在当前 dsh 版本上做精确豁免。即使豁免了，第 2 层的形状检查仍然生效。

## 6. 发布清单

1. `SHADOW_STRICT_TODO=1 node tests/run.mjs` 通过（无 todo 遗留），或在 CHANGELOG 中说明保留的 todo
2. 在没有沙箱限制的终端里 `node scripts/pack-check.mjs` 通过
3. `package.json` 版本、`CHANGELOG.md` 的 Unreleased 改为版本号与日期、`lib/index.js` 的 `EXPECTED_RUNTIME` 是否需要更新
4. `git tag v<版本>`，推送分支与 tag
5. npm 发布（ADR-010），在源码 checkout 里：

   ```sh
   npm login                      # 维护者账号；只需一次
   npm whoami
   npm publish --dry-run          # 核对文件清单：lib/、cordis.patch.yml、README×2、CHANGELOG、LICENSE、package.json
   npm publish --access public
   npm view dsh-plugin-shadow version
   ```

   发布后 72 小时内可 `npm unpublish dsh-plugin-shadow@<版本>`；之后同一版本号永远不能再用。
