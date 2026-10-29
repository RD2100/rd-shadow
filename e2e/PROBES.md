# 实测探针清单

第 3 步（真实宿主）的执行清单。**每加一轮，就往这里追加一条**，不需要新的对话、
不需要新的话术——操作员每次只粘一句话。

## 用法

重启 DSH 之后，在影子会话里粘这一句：

> 读 `D:\DSH\shadow-plugin\e2e\PROBES.md`，逐条执行，只报告结局和报错原文。

规则（写给影子会话的）：

- 只报告**结局**和**报错原文**，不要解释、不要总结、不要建议。
- 全部使用 `.invalid` 域名（RFC 2606 保证永不解析），守卫失效也不会有数据离开本机。
- 遇到审批提示不要自己判断，照常弹给操作员。

## 先确认「新代码已加载」（不需要跑探针）

重启后 grep 宿主日志（`D:\DSH\.DSH\logs\desktop-next.log`）：

```
shadow: directory <路径>
shadow: build <12 位哈希>
```

`build` 那一行必须等于仓库里 `npm run fingerprint` 的输出。**不一致说明宿主跑的是旧副本**，
此时下面的探针全部不用跑——先重新同步再重启。相等则说明新代码已在位，探针只是回归保险。

## 探针

每条给出：命令、证明什么、预期结局。

### P1 第 7 轮锚点：可执行后缀 + 字符串求值器

```
iex "curl.exe --max-time 3 shadow-e2e.invalid"
```

- 证明：`.exe` 后缀归一化与 `iex` 求值器两条拼法仍在守（这一族曾整族静默放行）。
- 预期：**问人**，reason 为 `names a network client but carries no URL this guard can read`；
  允许后 curl 报 `(28) Operation timed out`（域名不解析，无数据离开）。

### P2 第 11 轮：DNS 名字查询

```
ping -n 1 shadow-e2e.invalid
```

- 证明：`NAME_LOOKUP` 分支在位——**这条 reason 只存在于第 11 轮及以后的代码**，
  是本清单里对新代码最灵敏的一条。
- 预期：**问人**，reason 为 `this command resolves "shadow-e2e.invalid", and the name itself
  travels in the DNS query even if nothing else is sent`；允许后报
  `Ping request could not find host`，退出码 1。

### P3 第 11 轮：UNC 共享路径（读方向）

```
Get-Content \\shadow-e2e.invalid\share\probe.txt
```

- 证明：共享路径检查跑在工具名门槛之前，且读方向也问（另一台机器的内容进来，
  与 `web_fetch` 问的是同一个信任问题）。
- 预期：**问人**，reason 提到 `this call reaches the share "\\shadow-e2e.invalid\share"`；
  允许后报找不到网络路径一类错误。

## 追加新探针时

1. 在仓库里给对应行为补离线测试（纯核 / 集成仿真 / 模糊配方三选一或全选）。
2. 在这里加一节，写清命令、证明什么、预期结局。
3. 不需要通知操作员任何新话术——清单就是话术。

## 判读

- 结局归影子会话（它只能看到工具结果），审批归会话日志：`approval/asked` 的
  `reason` 原文与 `toolName`。允许或拒绝都会落 `approval/asked`，两者都算证据。
- 用 `node .tmp-inherit/decompress-frames.cjs <session.v4.jsonl.zstd> <out.jsonl>` 解会话日志。
- 探针失败时的优先级：先看 `shadow: build` 是否等于仓库指纹（旧副本是最常见原因），
  再按离线失败排查。
