/**
 * Pin the build fingerprint's contract: it follows the bytes, not a declaration.
 *
 * The stamp exists so "did the restart load the new code?" is a log line rather
 * than a probe an operator has to run. That promise is only worth anything if
 * the number actually changes when the code changes and stays put when nothing
 * does — which is what the copies below assert, without touching the checkout.
 *
 * Usage: node tests/build-stamp.test.mjs
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { suite } from './harness.mjs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { check, done } = suite('build-stamp')

/** Throw unless the condition holds; keeps the original boolean assertions readable. */
function expect(ok, detail = '') {
  if (!ok) throw new Error(detail === '' ? 'assertion failed' : detail)
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIB = path.join(ROOT, 'lib')

/** Scratch roots this test created; the only ones it may remove. */
const roots = []

/**
 * Copy the runtime modules into a scratch directory so the stamp can read them.
 * @param tag - subdirectory name, so each staged copy is distinguishable.
 * @returns the staged directory.
 */
function stage(tag) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shadow-stamp-'))
  roots.push(root)
  const dir = path.join(root, tag)
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    cpSync(path.join(LIB, name), path.join(dir, name))
  }
  return dir
}

const stampOf = async (dir, bust = '') => (await import(`${pathToFileURL(path.join(dir, 'build-stamp.js')).href}${bust}`)).buildStamp()

// 1. The checkout's own stamp is readable and covers every runtime module: a
// module the hash does not see is a module whose changes go unnoticed.
const own = await stampOf(LIB)
const moduleCount = readdirSync(LIB).filter((n) => n.endsWith('.js')).length
await check('TC-STAMP-001', 'the checkout produces a stamp', async () => expect(own !== null && typeof own.hash === 'string' && own.hash.length === 12))
await check('TC-STAMP-002', 'the stamp covers every runtime module', async () => expect(own?.files === moduleCount, `expected ${String(moduleCount)}, got ${String(own?.files)}`))

// 2. Two identical copies agree: the number is a property of the bytes, so a
// redeployed copy of the same code reports the same hash as the checkout.
const first = stage('a')
const second = stage('b')
await check('TC-STAMP-003', 'identical copies produce the same stamp', async () => expect((await stampOf(first)).hash === (await stampOf(second)).hash))

// 3. One changed byte changes the stamp: this is the property the whole
// diagnostic rests on, so it is asserted directly rather than inferred.
writeFileSync(path.join(first, 'tools.js'), `${readFileSync(path.join(first, 'tools.js'), 'utf8')}\n// one byte of difference\n`)
const changed = await stampOf(first, '?v=2')
await check('TC-STAMP-004', 'a changed module changes the stamp', async () => expect(changed.hash !== own?.hash, `${String(own?.hash)} -> ${String(changed.hash)}`))

// 4. An added module changes the stamp too, even when every existing file is
// untouched — a new file the hash ignored would be a silent guard change. The
// listing is not recursive on purpose: only the runtime directory counts, so the
// added module has to sit beside the others to be seen at all.
cpSync(path.join(LIB, 'tools.js'), path.join(second, 'later.js'))
const added = await stampOf(second, '?v=2')
await check('TC-STAMP-005', 'an added module changes the stamp', async () => expect(added.hash !== own?.hash && added.files === (own?.files ?? 0) + 1,
  `expected ${String(own?.files)} files, got ${String(added.files)}`))

// 5. Unreadable files cost the line, never the mount: a name the listing reports
// but the read cannot open (here, a directory standing in for a module) must
// yield null rather than an exception that would take the plugin down.
const broken = stage('c')
rmSync(path.join(broken, 'tools.js'))
mkdirSync(path.join(broken, 'tools.js'))
await check('TC-STAMP-006', 'an unreadable module reports null rather than throwing', async () => expect((await stampOf(broken, '?v=3')) === null))

// Remove the scratch roots and nothing else: each one is a direct child of the
// temp dir, and a test that cleaned up by guessing would be one typo away from
// deleting something it does not own.
for (const root of roots) {
  if (path.dirname(root) !== os.tmpdir()) {
    console.error(`FAIL refusing to clean outside the temp dir: ${root}`)
    process.exitCode = 1
    continue
  }
  rmSync(root, { recursive: true, force: true })
}

await done()
