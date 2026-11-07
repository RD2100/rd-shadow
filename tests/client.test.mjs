/**
 * Checks for the browser half, which no other suite touches.
 *
 * `lib/client.js` is a ModuleLoader bundle: it talks to the renderer through
 * `require`, and its behaviour lives inside `apply`. A typo there fails silently
 * (the panel simply never appears), and the "could not adopt" storm this suite
 * was written after was exactly such a defect. These checks load the real bundle
 * with stub modules, then drive the operations its slot exposes.
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const { check, done } = suite('client')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE = fs.readFileSync(process.env.SHADOW_CLIENT ?? path.join(ROOT, 'lib', 'client.js'), 'utf8')

/** Load the bundle in a sandbox and return its exports plus the slot it registers. */
function loadBundle() {
  let captured
  const loaded = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => loaded.push(definition) } },
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  const { id, factory } = loaded[0]
  const states = []
  let cursor = 0
  const stub = {
    react: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (value) => {
        const index = cursor++
        if (!(index in states)) states[index] = value
        return [states[index], (next) => { states[index] = next }]
      },
      useRef: () => ({ current: null }),
      useMemo: (fn) => fn(),
      useLayoutEffect: () => {},
    },
    '@deepseek-ai/dsh-client-ui-primitives': { useDismissOnOutsidePointer: () => {} },
  }
  const module = factory((specifier) => {
    if (!(specifier in stub)) throw new Error(`unexpected require: ${specifier}`)
    return stub[specifier]
  })
  return { id, exports: module, takeSlot: () => captured, render: (component, props) => { cursor = 0; return component(props) } }
}

/**
 * Install the bundle over a fake renderer context.
 * @param options - service behaviour for this scenario.
 * @returns the slot definition plus the recorded calls.
 */
function mount(options = {}) {
  const { id, exports, render } = loadBundle()
  const calls = { opened: [], created: [], registered: [], locale: [] }
  let slot
  let component
  const ctx = {
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {} },
    locale: { register: (namespace, dictionaries) => calls.locale.push({ namespace, dictionaries }) },
    get: (name) => options.services?.[name],
    slots: {
      inject: (name, callback) => {
        calls.registered.push(name)
        callback()
      },
      register: (definition, render) => {
        slot = definition
        component = render
      },
    },
  }
  exports.apply(ctx, options.noConfig ? undefined : { shadowDir: options.shadowDir ?? 'D:\\work\\shadow', shadowPresetId: 'shadow' })
  return { id, exports, slot, calls, component, render: (props) => render(component, props) }
}

/** Fake collaborator set that records what the panel asks for. */
function services(overrides = {}) {
  const calls = { opened: [], created: [], selectedModel: [], refreshed: [] }
  const world = overrides.world ?? { sessions: {}, workspaces: [], archivedIds: [] }
  return {
    calls,
    services: {
      uiWorkspace: { openSession: (sessionId) => calls.opened.push(sessionId) },
      sessions: {
        create: async (request) => {
          calls.created.push(request)
          return 'session-new'
        },
        selectModel: async (request) => calls.selectedModel.push(request),
        // What the browser half reads to discover the shadow Workspace.
        list: { getSnapshot: () => ({ byId: world.sessions }) },
        refreshProjections: async (id) => { calls.refreshed.push(id) },
      },
      workspaces: {
        list: { getSnapshot: () => ({ items: world.workspaces, archivedSessionIds: world.archivedIds }) },
        create: async (request) => {
          calls.created.unshift(request)
          return { ok: true, value: { workspace: { workspaceId: 'ws-1' } } }
        },
        archiveSession: async () => ({ ok: true }),
      },
      ...overrides,
    },
  }
}

/**
 * A world where the shadow owns a Workspace through its own Sessions.
 * @param shadowSessionIds - Sessions created with the shadow preset.
 * @param extra - extra sessions, workspaces, or archived ids.
 * @returns the `world` override for {@link services}.
 */
function shadowWorld(shadowSessionIds, extra = {}) {
  const sessions = {}
  for (const id of shadowSessionIds) {
    sessions[id] = { displayTitle: id, projectionValues: { agentPreset: 'shadow' } }
  }
  const workspaces = [{ workspaceId: 'ws-shadow', title: 'shadow', path: 'D:\\DSH\\shadow', sessionIds: shadowSessionIds }]
  return { sessions, workspaces, archivedIds: [], ...extra }
}

check('TC-CLIENT-001', 'the bundle declares its loader id and both plugin exports', () => {
  const { id, exports } = loadBundle()
  assert.equal(id, 'dsh-plugin-shadow')
  assert.equal(typeof exports.apply, 'function')
  // Read the sandbox array into this realm before the strict comparison.
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'uiWorkspace', 'sessions', 'workspaces'])
})

check('TC-CLIENT-002', 'apply registers the sidebar slot and the dictionaries', () => {
  const { slot, calls } = mount({ services: services().services })
  assert.deepEqual(calls.registered, ['sidebar.footer.action'])
  assert.equal(slot.name, 'sidebar.footer.action')
  assert.equal(slot.id, 'shadow-entry')
  assert.equal(slot.locale, 'shadow')
  assert.equal(calls.locale[0].namespace, 'shadow')
  assert.ok(calls.locale[0].dictionaries.zh['entry.label'] !== undefined)
  assert.ok(calls.locale[0].dictionaries.en['entry.label'] !== undefined)
})

check('TC-CLIENT-003', 'the slot face exposes the panel operations', () => {
  const { slot } = mount({ services: services().services })
  const face = slot.inject()
  for (const key of ['openShadow', 'createShadow', 'presetId', 'renameShadow', 'archiveShadow', 'shadowWorkspace']) {
    assert.ok(key in face, `missing ${key}`)
  }
  // The browser half never receives the row config, so the preset id is the
  // bundle's own constant; TC-PATCH-004 pins it against the patch row.
  assert.equal(face.presetId, 'shadow')
})

check('TC-CLIENT-004', 'an already-registered workspace still creates a Session (the adopt fix)', async () => {
  const { calls, services: fake } = services()
  // This is the shape that used to throw "could not adopt": ok:false carrying the entity.
  fake.workspaces.create = async (request) => {
    calls.created.unshift(request)
    return { ok: false, error: { workspaceId: 'ws-existing', path: request.path } }
  }
  const { slot } = mount({ services: fake })
  const sessionId = await slot.inject().createShadow()
  assert.equal(sessionId, 'session-new')
  // Objects built inside the sandbox carry the sandbox realm's prototypes, so copy
  // them into this realm before the strict comparison.
  assert.deepEqual({ ...calls.created[1] }, { workspaceId: 'ws-existing', agentPreset: 'shadow' })
  assert.deepEqual(calls.opened, ['session-new'])
})

check('TC-CLIENT-005', 'a bare workspace view is accepted too', async () => {
  const { calls, services: fake } = services()
  fake.workspaces.create = async (request) => {
    calls.created.unshift(request)
    return { workspaceId: 'ws-bare' }
  }
  const { slot } = mount({ services: fake })
  await slot.inject().createShadow()
  assert.deepEqual({ ...calls.created[1] }, { workspaceId: 'ws-bare', agentPreset: 'shadow' })
})

check('TC-CLIENT-006', 'a result with no identity at all fails loudly', async () => {
  const { services: fake } = services()
  fake.workspaces.create = async () => ({ ok: false, error: { message: 'nope' } })
  const { slot } = mount({ services: fake })
  await assert.rejects(() => slot.inject().createShadow(), /could not adopt/)
})

check('TC-CLIENT-007', 'a Session without an identity fails loudly', async () => {
  const { services: fake } = services()
  fake.sessions.create = async () => undefined
  const { slot } = mount({ services: fake })
  await assert.rejects(() => slot.inject().createShadow(), /no identity/)
})

check('TC-CLIENT-008', 'with no shadow workspace yet the panel says what to do', async () => {
  const { services: fake } = services()
  const { slot } = mount({ services: fake, shadowDir: '' })
  await assert.rejects(() => slot.inject().createShadow(), /no shadow workspace yet/)
})

check('TC-CLIENT-009', 'a model pin failure does not block creation', async () => {
  const { calls, services: fake } = services()
  fake.sessions.selectModel = async () => {
    throw new Error('route rejected')
  }
  const { slot } = mount({ services: fake })
  const originalError = console.error
  console.error = () => {}
  try {
    const sessionId = await slot.inject().createShadow({ provider: 'p', model: 'm' })
    assert.equal(sessionId, 'session-new')
  } finally {
    console.error = originalError
  }
  assert.deepEqual(calls.opened, ['session-new'])
})

check('TC-CLIENT-010', 'openShadow routes through the official navigation', () => {
  const { calls, services: fake } = services()
  const { slot } = mount({ services: fake })
  slot.inject().openShadow('session-x')
  assert.deepEqual(calls.opened, ['session-x'])
})

check('TC-CLIENT-011', 'a missing navigation service is reported', () => {
  const { slot } = mount({ services: { sessions: {}, workspaces: {} } })
  assert.throws(() => slot.inject().openShadow('session-x'), /uiWorkspace/)
})

/* ------------------------------------------------------------------ */
/* Workspace discovery (ADR-016)                                       */
/* ------------------------------------------------------------------ */

check('TC-CLIENT-012', 'the shadow workspace is found through its own Sessions, not a path', () => {
  const { slot } = mount({ services: services({ world: shadowWorld(['s1', 's2']) }).services })
  const face = slot.inject()
  assert.equal(face.shadowWorkspace?.workspaceId, 'ws-shadow')
})

check('TC-CLIENT-013', 'creating a conversation reuses the discovered workspace instead of adopting a path', async () => {
  const { calls, services: fake } = services({ world: shadowWorld(['s1']) })
  const adopt = fake.workspaces.create
  fake.workspaces.create = async () => { throw new Error('adopt must not be called') }
  const { slot } = mount({ services: fake })
  const sessionId = await slot.inject().createShadow()
  fake.workspaces.create = adopt
  assert.equal(sessionId, 'session-new')
  assert.deepEqual({ ...calls.created[0] }, { workspaceId: 'ws-shadow', agentPreset: 'shadow' })
})

check('TC-CLIENT-014', 'a workspace holding no shadow Session is not the shadow workspace', () => {
  const world = shadowWorld(['s1'], {
    sessions: {
      s1: { displayTitle: 's1', projectionValues: { agentPreset: 'shadow' } },
      other: { displayTitle: 'other', projectionValues: { agentPreset: 'standard' } },
    },
    workspaces: [
      { workspaceId: 'ws-shadow', title: 'shadow', path: 'D:\\DSH\\shadow', sessionIds: ['s1'] },
      { workspaceId: 'ws-other', title: 'proj', path: 'D:\\work\\proj', sessionIds: ['other'] },
    ],
  })
  const { slot } = mount({ services: services({ world }).services })
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'ws-shadow')
})

check('TC-CLIENT-015', 'archived shadow Sessions still identify the workspace for creating a new conversation', async () => {
  const world = shadowWorld([], {
    sessions: { old: { displayTitle: 'old', projectionValues: { agentPreset: 'shadow' } } },
    workspaces: [{ workspaceId: 'ws-old', title: 'old', path: 'D:\\old', sessionIds: ['old'] }],
    archivedIds: ['old'],
  })
  const { calls, services: fake } = services({ world })
  const { slot } = mount({ services: fake, noConfig: true })
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'ws-old')
  await slot.inject().createShadow()
  assert.equal(calls.created[0].workspaceId, 'ws-old')
  assert.deepEqual(world.archivedIds, ['old'])
})

check('TC-CLIENT-016', 'real snapshot stores without row config discover current workspace and archive changes', async () => {
  const world = shadowWorld([])
  const { calls, services: fake } = services({ world })
  const { slot } = mount({ services: fake, noConfig: true })
  assert.equal(slot.inject().shadowWorkspace, undefined)
  Object.assign(world, shadowWorld(['s1']))
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'ws-shadow')
  await slot.inject().createShadow()
  assert.deepEqual({ ...calls.created[0] }, { workspaceId: 'ws-shadow', agentPreset: 'shadow' })
  world.archivedIds = ['s1']
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'ws-shadow')
})

check('TC-CLIENT-017', 'the footer component renders its entry with the real snapshot-store contract', () => {
  const { calls, services: fake } = services({ world: shadowWorld(['s1']) })
  const { slot, component } = mount({ services: fake, noConfig: true })
  const tree = component({
    ...slot.inject(),
    wide: true,
    t: (key) => key,
    useSessions: (select) => select(fake.sessions.list.getSnapshot()),
    useWorkspaces: (select) => select(fake.workspaces.list.getSnapshot()),
  })
  const button = tree.children[0]
  assert.equal(button.props['aria-label'], 'entry.aria')
  button.props.onClick()
  assert.deepEqual(calls.opened, ['s1'])
})

check('TC-CLIENT-018', 'loading preset metadata finds cold shadow Sessions without opening them', async () => {
  const world = shadowWorld([], {
    sessions: { cold: {}, old: {}, child: { parentId: 'cold' } },
    workspaces: [{ workspaceId: 'ws-shadow', sessionIds: ['cold', 'old', 'child'] }],
    archivedIds: ['old'],
  })
  const { calls, services: fake } = services({ world })
  fake.sessions.refreshProjections = async (id) => {
    calls.refreshed.push(id)
    world.sessions[id].projectionValues = { agentPreset: 'shadow' }
  }
  const { slot } = mount({ services: fake, noConfig: true })
  assert.equal(slot.inject().shadowWorkspace, undefined)
  await slot.inject().refreshShadows()
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'ws-shadow')
  assert.deepEqual(calls.refreshed, ['cold', 'old'])
  assert.deepEqual(calls.opened, [])
  assert.deepEqual(calls.created, [])
})

check('TC-CLIENT-019', 'clicking an undiscovered shadow opens a visible panel and never silently creates a Session', async () => {
  const { calls, services: fake } = services()
  const { slot, render } = mount({ services: fake, noConfig: true })
  const props = () => ({
    ...slot.inject(), wide: true, t: (key) => key,
    useSessions: (select) => select(fake.sessions.list.getSnapshot()),
    useWorkspaces: (select) => select(fake.workspaces.list.getSnapshot()),
  })
  render(props()).children[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  // With a panel open, the layout effect measures its anchor in the browser.
  // The button's expanded state is independent of that DOM-only measurement.
  assert.equal(render(props()).children[0].props['aria-expanded'], true)
  assert.deepEqual(calls.created, [])
})

check('TC-CLIENT-020', 'a live root shadow workspace beats archived history and subagent presets', () => {
  const world = shadowWorld([], {
    sessions: {
      old: { projectionValues: { agentPreset: 'shadow' } },
      child: { parentId: 'parent', projectionValues: { agentPreset: 'shadow' } },
      root: { projectionValues: { agentPreset: 'shadow' } },
    },
    workspaces: [
      { workspaceId: 'history', sessionIds: ['old'] },
      { workspaceId: 'child-only', sessionIds: ['child'] },
      { workspaceId: 'active', sessionIds: ['root'] },
    ],
    archivedIds: ['old'],
  })
  const { slot } = mount({ services: services({ world }).services, noConfig: true })
  assert.equal(slot.inject().shadowWorkspace?.workspaceId, 'active')
  world.workspaces = [world.workspaces[1]]
  assert.equal(slot.inject().shadowWorkspace, undefined)
})

await done()
