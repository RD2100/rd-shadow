/**
 * Re-verify the runtime contract against this machine's real DSH session logs
 * (docs/decisions.md ADR-013, docs/operations.md §6).
 *
 * Read-only. Prints counts and problem descriptions only, never message text.
 *
 * Usage:
 *   node scripts/contract-probe.mjs --home <DSH_HOME> [--limit 20] [--asar <app.asar>]
 *     --home   the DSH data root (contains sessions/); defaults to $DSH_HOME
 *     --limit  newest session logs to check (default 20)
 *     --asar   also print the installed runtime version from app.asar
 *
 * Exit code 1 when any log has a folded event the plugin would refuse.
 */
import { openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { VERIFIED_RUNTIME } from '../lib/core-contract.js'
import { collectReply } from '../lib/core-reply.js'
import { eventProblems } from '../lib/core-shape.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a `session.v4.jsonl.zstd` file: a sequence of independent zstd frames.
 * A magic number that happens to occur inside a frame's payload splits it
 * wrongly; such a piece fails to decode and is merged with the next one.
 * @param raw - the file bytes.
 * @returns the concatenated text.
 */
export function decodeFrames(raw) {
  const starts = []
  for (let i = raw.indexOf(ZSTD_MAGIC); i >= 0; i = raw.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i)
  const parts = []
  let from = 0
  while (from < starts.length) {
    let to = from + 1
    for (;;) {
      const chunk = raw.subarray(starts[from], to < starts.length ? starts[to] : raw.length)
      try {
        parts.push(zlib.zstdDecompressSync(chunk).toString('utf8'))
        break
      } catch (error) {
        if (to >= starts.length) throw error
        to += 1
      }
    }
    from = to
  }
  return parts.join('')
}

/**
 * Check one decoded log.
 * @param text - JSONL: a header line, then one event per line.
 * @returns `{events, problems, replyChars}` — replyChars is the length of the latest visible reply, or null.
 */
export function probeLog(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const entry = JSON.parse(line)
    if (Number.isSafeInteger(entry?.seq)) events.push(entry)
  }
  const reply = collectReply({ events, afterSeq: -1 })
  return { events: events.length, problems: eventProblems(events), replyChars: reply.latest?.chars ?? null }
}

/**
 * The newest session logs under a DSH home.
 * @param home - the DSH data root.
 * @param limit - how many to return.
 * @returns absolute file paths, newest first.
 */
function newestLogs(home, limit) {
  const found = []
  const root = path.join(home, 'sessions')
  for (const workspace of readdirSync(root)) {
    const dir = path.join(root, workspace)
    if (!statSync(dir).isDirectory()) continue
    for (const session of readdirSync(dir)) {
      const file = path.join(dir, session, 'session.v4.jsonl.zstd')
      try {
        found.push({ file, time: statSync(file).mtimeMs })
      } catch {
        // not a session directory
      }
    }
  }
  return found.sort((a, b) => b.time - a.time).slice(0, limit).map((entry) => entry.file)
}

/**
 * The runtime version app-boot reports, read from app.asar without unpacking it.
 * @param asar - path to app.asar.
 * @returns the version string.
 */
function asarRuntimeVersion(asar) {
  const fd = openSync(asar, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const json = Buffer.alloc(head.readUInt32LE(12))
  readSync(fd, json, 0, json.length, 16)
  let node = JSON.parse(json.toString('utf8'))
  for (const part of ['node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json']) node = node.files?.[part]
  if (node === undefined) throw new Error('app.asar has no @deepseek-ai/dsh-app-boot/package.json')
  const buf = Buffer.alloc(node.size)
  readSync(fd, buf, 0, node.size, 8 + head.readUInt32LE(4) + Number(node.offset))
  return JSON.parse(buf.toString('utf8')).version
}

/** Read one flag value. */
function flag(name) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  console.log(`verified runtime: ${VERIFIED_RUNTIME}; engines.dsh: ${manifest.engines?.dsh ?? '(none)'}`)
  const asar = flag('--asar')
  if (asar !== undefined) console.log(`installed runtime (app-boot in ${asar}): ${asarRuntimeVersion(asar)}`)

  const home = flag('--home') ?? process.env.DSH_HOME
  if (home === undefined) {
    console.error('usage: node scripts/contract-probe.mjs --home <DSH_HOME> [--limit 20] [--asar <app.asar>]')
    process.exit(2)
  }
  let failing = 0
  for (const file of newestLogs(home, Number(flag('--limit') ?? 20))) {
    const session = path.basename(path.dirname(file))
    try {
      const result = probeLog(decodeFrames(readFileSync(file)))
      const verdict = result.problems.length === 0 ? 'ok  ' : 'FAIL'
      if (result.problems.length > 0) failing += 1
      console.log(`${verdict} ${session}: ${result.events} events, latest reply ${result.replyChars ?? '-'} chars${result.problems.length === 0 ? '' : `; ${result.problems.join('; ')}`}`)
    } catch (error) {
      failing += 1
      console.log(`FAIL ${session}: unreadable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  console.log(failing === 0 ? 'contract probe: every checked log matches' : `contract probe: ${failing} log(s) drifted`)
  process.exitCode = failing === 0 ? 0 : 1
}
