/**
 * Pin the restart judge's contract: it clears a restart only for bytes that a
 * named commit actually contains.
 *
 * The judge exists so "may I restart now?" and "did the restart take effect?"
 * stop being things a person reads a log to answer. That promise rests on one
 * property: the deployed copy must equal a specific commit, byte for byte, and
 * anything else — a planted module, an edited patch, a stale version — must
 * fail loudly with the offending file named. These checks build a throwaway git
 * repo so the failure modes are produced rather than described.
 *
 * Usage: node tests/verify-restart.test.mjs
 */
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIB = path.join(ROOT, 'lib')

const {
  appendLedger, deployedHash, expectedHash, judge, parseArgs, pendingArm, readLedger, runAll, runJudge,
} = await import(pathToFileURL(path.join(ROOT, 'scripts', 'verify-and-restart.mjs')).href)

let failures = 0

/** Report one assertion. */
function check(label, ok, detail = '') {
  if (ok) console.log(`ok   ${label}`)
  else {
    failures += 1
    console.error(`FAIL ${label}${detail === '' ? '' : `: ${detail}`}`)
  }
}

/** Scratch roots this test created; the only ones it may remove. */
const roots = []

/**
 * @param {string} tag - subdirectory name.
 * @returns {string} a fresh scratch root.
 */
function scratch(tag) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shadow-judge-'))
  roots.push(root)
  const dir = path.join(root, tag)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * @param {string[]} args - git arguments.
 * @param {string} cwd - repository to run in.
 * @returns {string} stdout.
 */
function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=judge-test', '-c', 'user.email=judge@test', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Build a throwaway repository holding the same shape as this one: lib modules,
 * the bundle patch, and the package manifest. Committed, so `git show` works.
 * @returns {{repo: string, commit: string, source: string}} paths and the commit.
 */
function makeRepo() {
  const repo = scratch('repo')
  mkdirSync(path.join(repo, 'lib'), { recursive: true })
  for (const name of readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    cpSync(path.join(LIB, name), path.join(repo, 'lib', name))
  }
  cpSync(path.join(ROOT, 'cordis.patch.yml'), path.join(repo, 'cordis.patch.yml'))
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  pkg.name = 'dsh-plugin-shadow'
  writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  git(['init', '-b', 'main', '.'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-m', 'staged for the judge test'], repo)
  return { repo, commit: git(['rev-parse', 'HEAD'], repo).trim(), source: repo }
}

/**
 * A deployed copy: the committed files, copied out as the sync script would.
 * @param {{repo: string, commit: string}} staged - the throwaway repository.
 * @returns {string} the deployed directory.
 */
function deploy(staged) {
  const target = scratch('deployed')
  mkdirSync(path.join(target, 'lib'), { recursive: true })
  for (const name of readdirSync(path.join(staged.repo, 'lib')).filter((n) => n.endsWith('.js'))) {
    cpSync(path.join(staged.repo, 'lib', name), path.join(target, 'lib', name))
  }
  cpSync(path.join(staged.repo, 'cordis.patch.yml'), path.join(target, 'cordis.patch.yml'))
  cpSync(path.join(staged.repo, 'package.json'), path.join(target, 'package.json'))
  return target
}

/**
 * A deployed copy built from a commit's own bytes, which is what a correct sync
 * produces. The self-checks below judge against this rather than the working
 * tree: an uncommitted version bump must fail the judge, not silently pass.
 * @param {string} commit - the commit to materialise.
 * @param {string} repoRoot - the repository holding it.
 * @returns {string} the deployed directory.
 */
function deployCommit(commit, repoRoot) {
  const target = scratch('deployed-commit')
  mkdirSync(path.join(target, 'lib'), { recursive: true })
  for (const name of readdirSync(path.join(repoRoot, 'lib')).filter((n) => n.endsWith('.js'))) {
    const bytes = execFileSync('git', ['show', `${commit}:lib/${name}`], { cwd: repoRoot, encoding: 'buffer' })
    writeFileSync(path.join(target, 'lib', name), bytes)
  }
  writeFileSync(path.join(target, 'cordis.patch.yml'), execFileSync('git', ['show', `${commit}:cordis.patch.yml`], { cwd: repoRoot, encoding: 'buffer' }))
  writeFileSync(path.join(target, 'package.json'), execFileSync('git', ['show', `${commit}:package.json`], { cwd: repoRoot, encoding: 'buffer' }))
  return target
}

const staged = makeRepo()

// 1. A deployed copy that matches the commit clears the restart. This is the
// only shape that may ever say yes.
check('a matching deployed copy passes', judge(staged.commit, deploy(staged), staged.repo).ok)

// 2. One changed byte in one module fails, and names that module: an operator
// reading the output must not have to guess which file drifted.
{
  const target = deploy(staged)
  writeFileSync(path.join(target, 'lib', 'dispatch-core.js'),
    `${readFileSync(path.join(target, 'lib', 'dispatch-core.js'), 'utf8')}\n// one byte of difference\n`)
  const result = judge(staged.commit, target, staged.repo)
  const failed = result.checks.find((c) => !c.ok)
  check('one changed byte fails and names the file',
    !result.ok && failed?.name === 'bytes match: lib/dispatch-core.js', `failed check: ${String(failed?.name)}`)
}

// 3. A module the commit does not contain fails on the set, not on the bytes:
// comparing only shared files would wave a planted guard through.
{
  const target = deploy(staged)
  writeFileSync(path.join(target, 'lib', 'rogue.js'), 'export const guard = () => "allow"\n')
  const result = judge(staged.commit, target, staged.repo)
  check('a module the commit does not have fails', !result.ok && result.checks.some((c) => c.name === 'module set matches' && !c.ok))
}

// 4. The bundle patch is load-bearing: the host reads it at boot to wire the
// guard, so editing it is the same class of change as editing lib/.
{
  const target = deploy(staged)
  writeFileSync(path.join(target, 'cordis.patch.yml'), `${readFileSync(path.join(target, 'cordis.patch.yml'), 'utf8')}# edited\n`)
  const result = judge(staged.commit, target, staged.repo)
  check('an edited bundle patch fails', !result.ok && result.checks.some((c) => c.name === 'bytes match: cordis.patch.yml' && !c.ok))
}

// 5. A stale version fails: cheap, but it catches the half-synced copy.
{
  const target = deploy(staged)
  const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))
  pkg.version = '0.0.0-stale'
  writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  const result = judge(staged.commit, target, staged.repo)
  check('a stale version fails', !result.ok && result.checks.some((c) => c.name === 'version matches' && !c.ok))
}

// 6. A commit that does not exist fails before anything else is compared: an
// unresolvable name cannot be the answer to "what should be loaded".
check('an unknown commit fails first', !judge('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', deploy(staged), staged.repo).ok)

// 7. No deployed copy at all fails rather than passing by absence.
check('a missing deployed copy fails', !judge(staged.commit, path.join(staged.repo, 'nowhere'), staged.repo).ok)

// 8. The judge's expected stamp is the same number the host would print: it is
// computed by the repository's own build-stamp.js over that commit's lib/, so
// the two cannot drift apart. A commit with one changed byte must differ.
{
  const fromCommit = await expectedHash(staged.commit, staged.repo)
  const fromModule = await deployedHash(staged.repo)
  check('the expected stamp equals the stamp of those bytes', fromCommit === fromModule && typeof fromCommit === 'string' && fromCommit.length === 12, `${String(fromCommit)} vs ${String(fromModule)}`)

  const edited = scratch('edited')
  cpSync(staged.repo, edited, { recursive: true })
  writeFileSync(path.join(edited, 'lib', 'tools.js'), `${readFileSync(path.join(edited, 'lib', 'tools.js'), 'utf8')}\n// one byte\n`)
  git(['add', '-A'], edited)
  git(['commit', '-m', 'one byte'], edited)
  const other = await expectedHash(git(['rev-parse', 'HEAD'], edited).trim(), edited)
  check('a different commit yields a different stamp', other !== fromCommit, `${String(fromCommit)} vs ${String(other)}`)
}

// 9. The real checkout judges itself: a deployed copy materialised from HEAD's
// own bytes must pass. This is what keeps the judge honest about the repository
// it ships in — and it fails while the version bump is still uncommitted, which
// is the judge doing its job rather than a test to work around.
{
  const head = git(['rev-parse', 'HEAD'], ROOT).trim()
  check('the checkout itself passes the judge', judge(head, deployCommit(head, ROOT), ROOT).ok)
}

// 10. A dry run judges without writing: the ledger is a record of decisions
// actually taken, so a rehearsal must leave no trace.
{
  const ledger = path.join(scratch('ledger'), 'ledger.jsonl')
  const home = os.tmpdir()
  const armed = { commit: git(['rev-parse', 'HEAD'], ROOT).trim() }
  const target = deployCommit(armed.commit, ROOT)
  const result = await runJudge({ dryRun: true, deployed: target, repoRoot: ROOT }, home, ledger, armed)
  check('a dry run judges and writes nothing', result.ok && !existsSync(ledger))
}

// 11. The ledger round-trips, and unknown arguments are refused rather than
// ignored: a silently dropped flag would turn into a silently skipped check.
{
  const ledger = path.join(scratch('ledger2'), 'ledger.jsonl')
  appendLedger(ledger, { kind: 'arm', commit: 'abc123' })
  const entries = readLedger(ledger)
  check('the ledger round-trips', entries.length === 1 && entries[0].kind === 'arm' && entries[0].commit === 'abc123')
  let refused = false
  try { parseArgs(['judge', '--nonsense']) } catch { refused = true }
  check('an unknown argument is refused', refused)
}

// 12. 全自动的一轮：判定通过就把重启交给 worker。这里用一个假的重启——
// 它把宿主的自报行写进日志，模拟应用回来那一刻。裁判自己活不过那一下 taskkill
// （它跑在宿主的进程树里），所以它交完就返回：账上到 restart 为止，
// relaunch 与 verify 由 worker 写。测试同时盯着裁判有没有多管闲事去杀进程。
{
  const target = deploy(staged)
  const home = scratch('home')
  mkdirSync(path.join(home, 'logs'), { recursive: true })
  writeFileSync(path.join(home, 'logs', 'desktop-next.log'), '2026-01-01T00:00:00.000Z [info] host: booting\n')
  const ledger = path.join(scratch('ledger3'), 'ledger.jsonl')
  const stamp = await expectedHash(staged.commit, staged.repo)
  const calls = []
  const fakeRestart = (round) => {
    calls.push(round)
    appendFileSync(path.join(home, 'logs', 'desktop-next.log'),
      `2026-01-01T00:00:01.000Z [info] shadow: build ${String(stamp)} over 6 files\n`)
  }
  const options = { dryRun: false, deployed: target, dshHome: home, repoRoot: staged.repo }
  const result = await runAll(options, home, ledger, { commit: staged.commit }, fakeRestart)
  const stages = readLedger(ledger).filter((e) => e.kind === 'outcome').map((e) => e.stage)
  check('a matching copy hands the restart to the worker', result.ok && calls.length === 1 && calls[0].expect === stamp, result.detail)
  check('the judge stops at the handover', JSON.stringify(stages) === JSON.stringify(['judge', 'restart']), stages.join(','))
}

// 13. 判定不过就绝不动手：这是整条链唯一的安全性质，所以直接用真进程计数来钉。
{
  const target = deploy(staged)
  writeFileSync(path.join(target, 'lib', 'tools.js'), `${readFileSync(path.join(target, 'lib', 'tools.js'), 'utf8')}\n// tampered\n`)
  const home = scratch('home2')
  mkdirSync(path.join(home, 'logs'), { recursive: true })
  writeFileSync(path.join(home, 'logs', 'desktop-next.log'), '')
  const ledger = path.join(scratch('ledger4'), 'ledger.jsonl')
  const calls = []
  const result = await runAll({ dryRun: false, deployed: target, dshHome: home, repoRoot: staged.repo },
    home, ledger, { commit: staged.commit }, () => calls.push(Date.now()))
  check('a tampered copy never restarts anything', !result.ok && calls.length === 0 && result.stage === 'judge', result.detail)
}

// 14. watch 只对新的一条 arm 动手：同一个提交反复重启，每一次都会打断正在跑的任务。
{
  const entries = [
    { kind: 'arm', commit: 'aaa' },
    { kind: 'outcome', stage: 'verify', commit: 'aaa', ok: true },
  ]
  check('an arm that already ran is not pending again', pendingArm(entries) === undefined)
  check('a fresh arm is pending', pendingArm([{ kind: 'arm', commit: 'bbb' }])?.commit === 'bbb')
  check('nothing armed is not pending', pendingArm([]) === undefined)
}

// Remove the scratch roots and nothing else: each one is a direct child of the
// temp dir, and a test that cleaned up by guessing would be one typo away from
// deleting something it does not own.
for (const root of roots) {
  if (path.dirname(root) !== os.tmpdir()) {
    console.error(`FAIL refusing to clean outside the temp dir: ${root}`)
    failures += 1
    continue
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'restart judge: all checks passed' : `restart judge: ${String(failures)} failed`)
process.exitCode = failures === 0 ? 0 : 1
