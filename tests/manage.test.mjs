import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { createSession, archiveSession } from '../lib/op-manage.js'
import { createHost } from '../lib/host-io.js'
const { check, done } = suite('manage')

function fixture() {
  const logs = new Map()
  const archived = []
  const members = []
  const live = new Map()
  const effects = []
  const caller = { id: 'session-shadow', session: { id: 'session-shadow', header: { cwd: 'D:/shadow' } } }
  const scope = {
    agents: { get: id => live.get(id) }, llm: { resolveModelInfo() {} },
    workspaceRegistry: {
      get: id => id === 'w' ? { id, path: 'D:/project', sessionIds: members } : id === 'shadow' ? { id, path: 'D:/shadow', sessionIds: [] } : undefined,
      list: () => [], archivedSessionIds: archived,
      async archiveSession(id) { effects.push(['archive', id]); if (live.get(id)?.status === 'running') throw new Error('active'); archived.push(id) },
    },
    sessionQuery: { listSessions() {}, readTitleSnapshots() {},
      async observeSession(id) {
        const log = logs.get(id)
        if (!log) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { header: log.header, events: log.events, inheritedEventCount: 0, cursor: log.events.at(-1)?.seq ?? -1, [Symbol.dispose](){} }
      },
    },
    sessionController: { resolveAgent(){}, selectModel(){}, commands: {
      async create(request) {
        effects.push(['create', request])
        logs.set(request.sessionId, { header: { id: request.sessionId, cwd: 'D:/project', agentPreset: request.agentPreset }, events: [] })
        members.push(request.sessionId)
        return { sessionId: request.sessionId, agentPreset: request.agentPreset }
      },
      async rename(request) { effects.push(['rename', request]); return { title: request.title, seq: 0 } },
    } },
  }
  logs.set(caller.id, { header: caller.session.header, events: [] })
  const host = createHost(scope, { shadowDir: 'd:/shadow', get:()=>undefined })
  const call = (toolName, args, callId = toolName + '-1') => {
    const events = logs.get(caller.id).events
    events.push({ seq: events.length, type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(args) } })
    return { agent: caller, callId, arguments: args }
  }
  const target = (id='session-target', header={}) => {
    logs.set(id, { header: { id, cwd: 'D:/project', ...header }, events: [] }); members.push(id); return id
  }
  return { host, scope, logs, archived, members, live, effects, caller, call, target }
}
await check('TC-MANAGE-001', 'create makes an empty standard root session and replay never duplicates or renames it', async () => {
  const f = fixture(), args = { workspaceId: 'w', title: 'Test' }, exec = f.call('shadow_create', args)
  const r = await createSession(f.host, args, exec)
  assert.equal(r.status, 'created')
  assert.match(r.sessionId, /^session-[a-f0-9-]{36}$/)
  assert.equal(f.logs.get(r.sessionId).header.parentSession, undefined)
  assert.equal(f.effects[0][1].agentPreset, 'standard')
  assert.equal(f.effects[0][1].cwd, undefined)
  assert.equal(f.effects.length, 2)
  f.logs.get(r.sessionId).events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } })
  assert.equal((await createSession(f.host, args, exec)).status, 'already-created')
  assert.equal(f.effects.length, 2)
})
await check('TC-MANAGE-002', 'create refuses non-shadow, subagent, changed arguments, missing workspace and shadow directory', async () => {
  for (const variant of ['plain','subagent','args','missing','shadow','blank','long','drift']) {
    const f=fixture(), args={workspaceId: 'w',title:'Test'}
    if (variant==='missing') args.workspaceId='missing'
    if (variant==='shadow') args.workspaceId='shadow'
    if (variant==='blank') args.title=' '
    if (variant==='long') args.title='x'.repeat(121)
    const exec=f.call('shadow_create',args)
    if (variant==='plain') exec.agent={session:{header:{cwd:'D:/other'}}}
    if (variant==='subagent') f.caller.session.header.parentSession='p'
    if (variant==='args') args.title='Changed'
    if (variant==='drift') delete f.scope.sessionController.commands.create
    const r=await createSession(f.host,args,exec)
    assert.equal(r.status,'rejected',variant)
    assert.equal(r.reason, {plain:'not-shadow',subagent:'not-shadow',args:'identity-conflict',missing:'workspace-not-found',shadow:'shadow-workspace',blank:'invalid-title',long:'invalid-title',drift:'runtime-mismatch'}[variant])
    assert.equal(f.effects.length,0,variant)
  }
})
await check('TC-MANAGE-003', 'partial create and title failures retain a reconcilable identity', async () => {
  const f=fixture(), args={workspaceId:'w',title:'Test'},exec=f.call('shadow_create',args)
  f.scope.sessionController.commands.rename=async()=>{throw new Error('failure')}
  const r=await createSession(f.host,args,exec)
  assert.equal(r.status,'partial')
  assert.ok(f.logs.has(r.sessionId))
  assert.equal((await createSession(f.host,args,exec)).status,'already-created')
  const g=fixture(), e=g.call('shadow_create',args)
  g.scope.sessionController.commands.create=async()=>{throw new Error('uncertain write')}
  const u=await createSession(g.host,args,e)
  assert.equal(u.status,'unknown');assert.ok(u.sessionId)
})
await check('TC-MANAGE-004', 'archive changes only archive membership and is idempotent', async () => {
  const f=fixture(),id=f.target(),args={workspaceId:'w',sessionId:id,confirmed:true},exec=f.call('shadow_archive',args)
  assert.equal((await archiveSession(f.host,args,exec)).status,'archived')
  assert.ok(f.logs.has(id))
  assert.ok(f.members.includes(id))
  assert.equal((await archiveSession(f.host,args,exec)).status,'already-archived')
  assert.equal(f.effects.length,1)
})
await check('TC-MANAGE-005', 'archive refuses missing confirmation, self, subagent, busy, pending, waiting and mismatched membership', async () => {
  for (const v of ['confirmation','self','subagent','busy','pending','waiting','membership','drift']) {
    const f=fixture(), id=f.target(), args={workspaceId:'w',sessionId:id,confirmed:true}
    if(v==='confirmation')args.confirmed=false
    if(v==='self'){args.sessionId=f.caller.id;f.members.push(f.caller.id)}
    if(v==='subagent')f.logs.get(id).header.parentSession='p'
    if(v==='busy')f.live.set(id,{status:'running'})
    if(v==='pending')f.logs.get(id).events.push({seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'m'}]}})
    if(v==='waiting')f.logs.get(id).events.push({seq:0,type:'tool/call',data:{callId:'q',name:'ask_user_question'}})
    if(v==='membership')f.members.splice(0)
    if(v==='drift')delete f.scope.workspaceRegistry.archiveSession
    const r=await archiveSession(f.host,args,f.call('shadow_archive',args))
    assert.equal(r.status,'rejected',v);assert.equal(f.effects.length,0,v)
  }
})
await check('TC-MANAGE-006', 'archive activity race refuses without cancelling or deleting', async () => {
  const f=fixture(),id=f.target(),args={workspaceId:'w',sessionId:id,confirmed:true}
  f.scope.workspaceRegistry.archiveSession=async()=>{throw Object.assign(new Error('active'),{name:'WorkspaceActiveSessionError', sessionId:id, activity:[{kind:'agent-running'}]})}
  const r=await archiveSession(f.host,args,f.call('shadow_archive',args))
  assert.equal(r.status,'rejected');assert.equal(r.reason,'busy');assert.ok(f.logs.has(id));assert.deepEqual(f.archived,[])
})
await done()
