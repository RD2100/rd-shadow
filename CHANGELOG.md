# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 待办（0.2.0 之后）

- 截图放进 README
- 决定是否发布到 npm（版本已就绪：`npm pack` 检查通过，见 `scripts/pack-check.mjs`）
- 设计文档英译（`DESIGN.md` / `DISPATCH-SPEC.md` 目前为中文）

## [0.2.0] — 2026-10-28

出网守卫按「举一反三排查 → 修复 → 再排查」循环做了五轮，每轮都抓到真实的洞或误报。这一版把守卫从「只认 URL」补成了「按目的地判定」，并消除了它自己引入的两类新问题。

### Fixed

- **出网守卫补洞**：目的地不在参数里的外发命令（`git push`、`git remote add/set-url`、`npm publish`、`docker push`、`scp`、`ssh`、DNS 查询、云 CLI 等）此前因只认 `http(s)://` URL 而全部无检查放行，现在一律问人；`git clone/fetch/pull` 的 scp 语法（`git@host:repo`）、非 HTTP 协议目的地、`mcp__*` 外服工具、拼不出可读 URL 的 `curl`/`wget` 同类处理；解释器（`python`/`node` 等）纳入外壳扫描；`web_fetch` 目的地不可读时问人，`web_search` 仍静默、仅在本轮读过受保护数据时才问
- **补全远程工具族**：`gh`（除 version/help/auth status/config get 外全部）、`svn`/`hg` 的提交/推送/克隆、`git send-email`/`ls-remote`/`submodule`、`Start-BitsTransfer`、数据库客户端（`psql`/`mysql`/`mongo`/`sqlcmd`/`redis-cli`）一律问人；其中目的地本身是 URL 的形式（`git clone https://…`、`svn checkout https://…`）仍走白名单
- **链式命令不能洗白外发**：`git push origin main && curl https://白名单域名` 这类写法此前因同一串文本里别处有 URL 而放行；URL 判断改为按 `;`/`&&`/`||`/`|`/`&`/换行分段进行，且引号内的分隔符不算分隔符
- **段首才算命令，散文不算**：宽矩阵探针发现 `git commit -m "fix: push hole and curl notes"` 会触发询问——提交信息里的命令名被当成了调用。现在命令名必须出现在段首（剥掉 `sudo`/`env`/`Start-Process`/`&`/`(` 等外壳之后）
- **可执行 span 不能借散文的静默**：上一轮的散文豁免开出了新洞——`echo $(curl https://evil.test)`、反引号替换、`(curl …)` 子shell、`if ($true) { curl … }`、`$c="curl"; & $c https://…` 全部因段首不是客户端而漏放。现在 `$(...)`/反引号/`{...}` 的内容按命令分析，子shell 外壳被剥掉，无法识别的命令词（含变量）一律 fail closed；只有显式的数据类命令（`echo`/`Write-Output`/`git commit`/构建工具等）把 URL 当散文
- **守卫自身失败时拒绝而非放行**：`tools/pre-execute` 里的污点读取与目的地判定包进同一个 try，任何内部错误都以「检查本身失败」为由拒绝该调用。之前在异常检查下放行，等于把 bug 变成洞
- **命令头归一化（端到端抓到的漏报）**：真实环境里模型写的是 `curl.exe --max-time 3 host`、`git.exe push`、`npm.cmd publish`、`C:\…\curl.exe`、`cmd /c curl …`、`powershell -c "curl …"`、`& "curl.exe" …`——可执行后缀、全路径、转发外壳、包裹引号这四种拼法让段首匹配全部失配，整条命令静默放行。现在判定前统一剥掉这些形态（循环到稳定），`yarnpkg publish` 一并补上；数据类命令的同名写法（`git.exe commit -m "docs: curl"`）仍是散文
- **端到端验证提示词的方法论缺陷**：提示词让影子自己报告「有没有弹审批」，但代理侧看不到审批弹窗——它只看到工具结果。审批是否发生由操作员在会话日志里核对（`approval/asked` 事件带守卫的 reason 原文），提示词已改写为「代理报结局、操作员核审批」
- **本机 URL 协议不算外发**：`web_fetch` 取 `data:`/`blob:`/`about:` 是本地读取，不再误报
- **监听器注册提前**：`session/created` 的注册先于权限身份诊断，诊断出问题也不影响钉权限

### Documentation

- 中英文 README 补全出网守卫的完整行为表（不可读目的地、外服工具、非 HTTP 协议一律问人）、「段首才算命令」的散文豁免与可执行 span（`$(...)`/反引号/`{}`/子shell）的解析，与「覆盖不到」清单（重定向、脚本/别名间接、解释器非 URL 外发、UNC/同步目录）
- 更正启动身份行的成因说明：bundles 是**并发**挂载（加载器用 `Promise.all` 激活整个列表），数组顺序只影响 import 发起的先后，不决定完成顺序，也不保证启动那行显示 `auto`；每个会话创建时都会重新解析

## [0.1.0] — 2026-10-28

首个可用版本：影子身份、调遣链路、权限身份。

### Added

- **侧栏入口与面板**：列出影子目录下的会话、选择打开、新建、重命名、归档
- **权限身份装配**：影子目录内的会话自动获得 `auto` 档（全盘沙箱 + 官方逐次评审），每次恢复重新钉住
- **`shadow_targets`**：列出工作区与会话（id、实时状态、归档/子代理标记、标题），影子自己发现目标
- **`shadow_inspect`**：只读查看单个会话的状态、工作目录、当前模型、事件序号；支持 `afterSeq`/`limit` 分页读事件，页头给出总数与末尾 seq
- **`shadow_dispatch`**：向目标会话投递消息，消息带 `source={kind:'agent-message', form:'relay', senderSessionId}`，回执含五态状态与精确的日志证据（`inbox@seq`、`user@seq`、`execution@seq`）
- **幂等**：同一次工具调用重放不会重复投递（确定性 messageId + 投递前扫描 + 同目标串行化）
- **可移植目录**：默认 `<家目录>/dsh-shadow`，支持 `~` 展开与行配置覆盖（浏览器半边要求显式配置）
- **启动预检**：缺服务或版本不匹配时点名告警，而非让影子会话莫名起不来
- **`enforcePermissionPreset` 配置**：默认 `true`（每次恢复写回 `permissionPreset`）；设为 `false` 时只钉日志里尚无权限选择的会话，手动切换的权限得以保留
- **离线验证体系**：`npm test` 覆盖纯核判断、host 预检、宿主仿真、patch 结构、发布产物自足性
- **CI**：ubuntu/windows × node 22/24 跑 `npm test`；CI 环境缺 js-yaml 时硬失败，避免 patch 校验被静默跳过

### Fixed

- 工具返回值形态（`output.schema` 要求字符串，回执需在 execute 内渲染）
- 日志中的工具参数是原始 JSON 字符串，直接深比较会把每次投递误判成身份冲突（新增 `argumentsMatch` 精确镜像官方解析）
- 目标无请求头时回退到宿主默认模型，而不是直接拒绝
- 状态判定优先级：持久阻断项（`waiting-user`/`pending`）高于 `cold`/`busy`
- `shadow_targets` 标题全空：`readTitleSnapshots` 返回包装信封 `{status, value}`，需两层解包
- 目标 id 少 `session-` 前缀时给出精确提示（`did you mean "session-…"?`），并把三种目标错误分开命名
- 工作区已存在时不再抛「could not adopt」（adopt 是幂等的）

### Known Limitations

- 每次工具调用都要过一次官方评审，实测单次 6–53 秒
- 不可逆操作的弹窗条件是「授权缺失」而非「每次必问」；评审不读文件系统
- 未挂载 `@deepseek-ai/dsh-experimental-auto-review` 时，影子会退化成全盘且不审批
- 仅支持带 GUI 的 profile；对 DSH 版本有硬依赖（`dsh-desktop-next 2.0.20-next` / harness `0.2.1-rc.3`）
