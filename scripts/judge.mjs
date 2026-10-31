#!/usr/bin/env node
/**
 * 裁判入口。重启那套机器不住在这个仓库里——它在 `dsh-plugin-restart`
 * （D:\DSH\restart-plugin）里，对要重启谁一无所知，由 `--repo` 指过来。
 * 这个包装只找到 restart 仓库并把参数原样交出去。
 *
 * 分开的理由：守卫管出网规则，重启机器管重启。两边各自发版，互不为对方的
 * 前置条件；这一行就是两者之间全部的耦合。
 *
 * 用法（与拆开之前一致）：
 *   npm run judge                     全自动：判定 → 重启 → 核对
 *   npm run judge -- arm --commit ..  记账
 *   npm run judge -- judge / verify / watch / status
 *   npm run judge -- status            查询重启账本
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RESTART = path.resolve(ROOT, '..', 'restart-plugin', 'scripts', 'verify-and-restart.mjs')
const args = process.argv.slice(2)

if (!existsSync(RESTART)) {
  console.error(`judge: the restart plugin is not next to this checkout (looked for ${RESTART}); the restart machinery lives there since 0.10.0`)
  process.exitCode = 1
} else {
  const result = spawnSync(process.execPath, [RESTART, '--repo', ROOT, ...args], { stdio: 'inherit', cwd: ROOT })
  process.exitCode = result.status ?? 1
}
