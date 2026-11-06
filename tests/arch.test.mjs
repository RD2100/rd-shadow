/**
 * Architecture guard: the module layering in docs/detailed-design.md §2 is
 * enforced here, so a change that crosses a layer fails offline instead of in a
 * running host.
 *
 * Every lib/*.js file must be classified in LAYERS. Adding a file means adding
 * it here and to the module table in docs/detailed-design.md §2.
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { check, done } = suite('arch')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIB = path.join(ROOT, 'lib')

/** Layer of every runtime file. */
const LAYERS = {
  'core-contract.js': 'core',
  'core-identity.js': 'core',
  'core-log.js': 'core',
  'core-admission.js': 'core',
  'core-render.js': 'core',
  'core-serial.js': 'core',
  'core-shape.js': 'core',
  'core-reply.js': 'core',
  'shadow-dir.js': 'support',
  'build-stamp.js': 'support',
  'dispatch-core.js': 'barrel',
  'host-io.js': 'host-io',
  'op-dispatch.js': 'op',
  'op-inspect.js': 'op',
  'op-targets.js': 'op',
  'index.js': 'entry-host',
  'tools.js': 'entry-tools',
  'client.js': 'client',
}

/** Which layers each layer may import, plus allowed bare specifiers. */
const ALLOWED = {
  core: { layers: ['core'], bare: ['node:crypto', 'node:util'] },
  support: { layers: [], bare: ['node:os', 'node:path', 'node:fs', 'node:crypto', 'node:url'] },
  barrel: { layers: ['core'], bare: [] },
  'host-io': { layers: ['core', 'support'], bare: [] },
  op: { layers: ['core'], bare: [] },
  'entry-host': { layers: ['support', 'core'], bare: [] },
  'entry-tools': { layers: ['core', 'support', 'host-io', 'op'], bare: ['@deepseek-ai/dsh-tools'] },
  client: { layers: [], bare: [] },
}

/** Maximum lines per runtime file; split before growing past it. */
const MAX_LINES = 400

/** Calls that act on another Session. Only op-dispatch.js may make them (client.js is the browser half). */
const EFFECTS = [/\.send\(/, /\.resolveAgent\(/, /\.selectModel\(/]

const files = readdirSync(LIB).filter((name) => name.endsWith('.js')).sort()
const sources = new Map(files.map((name) => [name, readFileSync(path.join(LIB, name), 'utf8')]))

/** Remove comments so prose cannot look like an import. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every static import/re-export specifier in one file. */
function specifiers(source) {
  const out = []
  for (const match of code(source).matchAll(/^(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]/gm)) out.push(match[1])
  for (const match of code(source).matchAll(/^import\s+['"]([^'"]+)['"]/gm)) out.push(match[1])
  return out
}

check('TC-ARCH-001', 'every runtime file is classified in a layer', () => {
  const unclassified = files.filter((name) => LAYERS[name] === undefined)
  const missing = Object.keys(LAYERS).filter((name) => !files.includes(name))
  assert.deepEqual({ unclassified, missing }, { unclassified: [], missing: [] })
})

check('TC-ARCH-002', 'imports follow the layer rules', () => {
  const problems = []
  for (const [name, source] of sources) {
    const layer = LAYERS[name]
    if (layer === undefined) continue
    const allowed = ALLOWED[layer]
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith('./')) {
        const targetLayer = LAYERS[specifier.slice(2)]
        if (targetLayer === undefined || !allowed.layers.includes(targetLayer)) {
          problems.push(`${name} (${layer}) imports ${specifier} (${String(targetLayer)})`)
        }
      } else if (!allowed.bare.includes(specifier)) {
        problems.push(`${name} (${layer}) imports ${specifier}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

check('TC-ARCH-003', 'no runtime file uses a dynamic import', () => {
  const offenders = files.filter((name) => /\bimport\(/.test(code(sources.get(name))))
  assert.deepEqual(offenders, [])
})

check('TC-ARCH-004', 'the barrel holds re-exports from core modules only', () => {
  const rest = code(sources.get('dispatch-core.js'))
    .replace(/export\s*\{[^}]*\}\s*from\s*'\.\/core-[a-z]+\.js'/g, '')
    .trim()
  assert.equal(rest, '')
})

check('TC-ARCH-005', 'only op-dispatch.js acts on another Session', () => {
  const offenders = []
  for (const [name, source] of sources) {
    if (name === 'op-dispatch.js' || name === 'client.js') continue
    for (const pattern of EFFECTS) if (pattern.test(code(source))) offenders.push(`${name} ${pattern}`)
  }
  assert.deepEqual(offenders, [])
})

check('TC-ARCH-006', 'no runtime file except the browser bundle exceeds 400 lines', () => {
  const long = files.filter((name) => LAYERS[name] !== 'client' && sources.get(name).split('\n').length > MAX_LINES)
  assert.deepEqual(long, [])
})

check('TC-ARCH-007', 'the browser half is a self-contained ModuleLoader bundle', () => {
  const source = sources.get('client.js')
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/)
  assert.deepEqual(specifiers(source), [])
})

check('TC-ARCH-008', 'every TODO in lib names its task card', () => {
  const loose = []
  for (const [name, source] of sources) {
    for (const line of source.split('\n')) {
      if (/\bTODO\b/.test(line) && !/TODO\(TASK-\d{2}\)/.test(line)) loose.push(`${name}: ${line.trim()}`)
    }
  }
  assert.deepEqual(loose, [])
})

await done()
