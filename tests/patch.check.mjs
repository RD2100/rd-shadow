/**
 * Validate the plugin's bundle patch the way the loader will read it.
 *
 * A YAML mistake here breaks the whole profile at startup, so this parses the
 * patch (including its `!!js` expressions) and asserts the shadow rows are where
 * DISPATCH-SPEC.md says they are.
 *
 * Needs a YAML parser: install `js-yaml`, or point `JS_YAML` at a module path.
 * Without one the check reports itself skipped instead of failing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATCH = path.join(ROOT, 'cordis.patch.yml')

/** The package name the patch rows must reference; a rename has to reach both files. */
const PACKAGE_NAME = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name

/** The directory the shipped patch pins; deployments may override it. */
const PATCH_SHADOW_DIR = 'D:\\DSH\\shadow'

/** Resolve the YAML parser from a module name or a filesystem path. */
function yamlSpecifier() {
  const requested = process.env.JS_YAML
  if (requested === undefined || requested.length === 0) return 'js-yaml'
  return path.isAbsolute(requested) ? pathToFileURL(requested).href : requested
}

let yaml
try {
  const loaded = await import(yamlSpecifier())
  yaml = loaded.default ?? loaded
} catch {
  // A local checkout without `npm install` may legitimately skip this; CI may not,
  // because a silently skipped bundle check would let a broken patch ship.
  const underCi = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false'
  if (underCi) {
    console.error('patch check: FAILED — js-yaml is unavailable under CI, so the bundle patch would go unverified. Run `npm install` first.')
    process.exit(1)
  }
  console.log('patch check: skipped (no js-yaml; set JS_YAML to a module path, or run `npm install`)')
  process.exit(0)
}

/** Accept every `!!js <expression>` scalar as its source text. */
const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => ({ __js: data }) })
const schema = yaml.DEFAULT_SCHEMA.extend([jsType])

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

const text = fs.readFileSync(PATCH, 'utf8')
let doc
check('patch parses as YAML with !!js expressions', () => {
  doc = yaml.load(text, { schema })
})
check('patch is a top-level array of entries', () => {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('expected a non-empty array')
})

const inserts = doc.filter((entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.insert))
check('one insert entry holds the preset and plugin rows', () => {
  if (inserts.length !== 1) throw new Error(`expected exactly one insert entry, found ${inserts.length}`)
})
const rows = inserts[0]?.insert ?? []
const byId = new Map(rows.map((row) => [row.id, row]))
const preset = byId.get('preset-shadow')
const plugins = preset?.config?.plugins ?? []
const ids = plugins.map((plugin) => plugin.id)

check('the shadow preset row exists and keeps its persona', () => {
  if (preset === undefined) throw new Error('missing preset-shadow row')
  if (preset.name !== '@deepseek-ai/dsh-agent-preset') throw new Error(`unexpected preset name ${preset.name}`)
  if (preset.config?.id !== 'shadow') throw new Error('preset id must stay "shadow"')
  const persona = plugins.find((plugin) => plugin.id === 'persona')
  if (typeof persona?.config?.prefix !== 'string' || !persona.config.prefix.includes('shadow coordinator')) {
    throw new Error('persona prefix changed unexpectedly')
  }
})

check('the dispatch tools row is rooted at the package name', () => {
  const at = ids.indexOf('shadow-tools')
  if (at < 0) throw new Error('missing shadow-tools row')
  if (ids[at - 1] !== 'tool-goal') throw new Error(`shadow-tools must follow tool-goal, found ${ids[at - 1]}`)
  const row = plugins[at]
  const expected = `${PACKAGE_NAME}/tools`
  if (row.name !== expected) {
    throw new Error(`tools row must be "${expected}" (package.json name + /tools), found "${String(row.name)}" — a package rename has to reach this row`)
  }
  if (row.config?.shadowDir !== PATCH_SHADOW_DIR) {
    throw new Error(`tools shadowDir must be ${PATCH_SHADOW_DIR}, got ${String(row.config?.shadowDir)}`)
  }
})

check('the host row keeps its directory and permission identity', () => {
  const host = byId.get('shadow')
  if (host === undefined) throw new Error('missing shadow row')
  if (host.name !== PACKAGE_NAME) {
    throw new Error(`host row must be "${PACKAGE_NAME}" (package.json name), found "${String(host.name)}" — a package rename has to reach this row`)
  }
  if (host.config?.shadowDir !== PATCH_SHADOW_DIR) throw new Error(`host shadowDir must be ${PATCH_SHADOW_DIR}`)
  if (host.config?.permissionPreset !== 'auto') throw new Error('host permissionPreset must stay "auto"')
  if (host.config?.shadowPresetId !== 'shadow') throw new Error('host shadowPresetId must stay "shadow"')
})

check('both rows name the same directory', () => {
  const tools = plugins.find((plugin) => plugin.id === 'shadow-tools')
  const host = byId.get('shadow')
  if (tools?.config?.shadowDir !== host?.config?.shadowDir) throw new Error('shadowDir drifted between rows')
})

check('the win32 tool selection is still expressed as !!js', () => {
  const bash = plugins.find((plugin) => plugin.id === 'tool-bash')
  const pwsh = plugins.find((plugin) => plugin.id === 'tool-pwsh')
  if (bash?.disabled?.__js === undefined) throw new Error('tool-bash disabled is no longer a !!js expression')
  if (pwsh?.disabled?.__js === undefined) throw new Error('tool-pwsh disabled is no longer a !!js expression')
})

console.log(`patch check: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
