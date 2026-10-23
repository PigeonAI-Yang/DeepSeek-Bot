import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { stripWrittenCalls, writesToolCall } from '../src/host/turns.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// One DS Bot host on `home`; a second start on the same home is a restart.
// Hosts by home: a home is removed only after its hosts stopped and their writes landed.
const started = new Map()

async function start(home) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const askApproval = sessionId => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox' }, () => 'from-dsh')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await tool('list_bots', {}, 'a')
  const host = { ctx, agentOf, emit, tool, call, askApproval, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
const inflight = home => notes(home).turns ?? {}
const writeInflight = (home, value) => writeFileSync(join(home, 'inflight.json'), JSON.stringify(value))
// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Starts a round in 'r1' and opens Writer's turn in 'gb'.
async function openRoomTurn(t, host) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  run(host, 'gb', 1, host.agentOf('gb').calls[0])
  return () => result
}

test('a resumed group turn with output reports a later cutoff without replaying work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await openRoomTurn(t, first)
  void first.askApproval('gb')
  await settle(() => inflight(home).gb?.approval !== undefined)
  assert.deepEqual([inflight(home).gb.botId, inflight(home).gb.roomId, inflight(home).gb.trigger.role], ['b', 'r1', 'room'])
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('gb').calls.length === 1)
  const post = second.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.resumed, post.source.quiet, post.source.senderSessionId], ['post', true, true, 'b'])
  const resumed = second.agentOf('gb').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.resumed, resumed.source.roomId], ['room', true, 'r1'])
  assert.match(text(resumed), /^\[Group chat "Ops" · picking up after a restart\]/)
  assert.match(text(resumed), /approval to run pwsh \(escalate sandbox\)/)
  await settle(() => inflight(home).gb?.resumeAttempt === 1)

  // The group shows the event, and the admin reads it on its next turn.
  second.emit('r1', 'user/message', { content: post.content, source: post.source })
  const relay = JSON.parse(await second.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  assert.deepEqual(relay.replies.map(reply => [reply.kind, reply.name]), [['resumed', 'Writer']])
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.r1.log.at(-1).kind, 'resumed')

  // Actual output is remembered, so a later restart reports the cut without replaying it.
  run(second, 'gb', 2, resumed)
  second.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'The draft is complete.' }] } })
  await settle(() => inflight(home).gb?.resumeProgress === true)
  await settle(() => inflight(home).gb?.resumed === true)
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('r1').calls.length === 1)
  assert.equal(third.agentOf('r1').calls[0].source.again, true)
  assert.equal(third.agentOf('gb').calls.length, 0)
})

test('synthetic interrupted turn/end before the resume timer keeps pending work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1 } }, queued: {} })
  const host = await start(home)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.equal(host.agentOf('a').calls[0].source.resumeAttempt, 1)
})

test('synthetic interrupted turn/end emitted inside resolveAgent is rechecked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1 } }, queued: {} })
  const host = await start(home)
  const resolveAgent = host.ctx.sessionController.resolveAgent.bind(host.ctx.sessionController)
  let emitted = false
  host.ctx.sessionController.resolveAgent = async (sessionId) => {
    if (sessionId === 'a' && !emitted) {
      emitted = true
      host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    }
    return resolveAgent(sessionId)
  }
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.equal(host.agentOf('a').calls[0].source.resumeAttempt, 1)
})

test('a restart before the resume timer leaves the original turn note available', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1 } }, queued: {} })
  const first = await start(home)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.equal(second.agentOf('a').calls[0].source.resumeAttempt, 1)
})

test('three interrupted no-output resumes are allowed and a fourth is not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'start work' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await settle(() => inflight(home).a !== undefined)
  await first.stop()

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const host = await start(home)
    t.mock.timers.tick(3000)
    await settle(() => host.agentOf('a').calls.length === 1)
    const [message] = host.agentOf('a').calls
    assert.equal(message.source.resumeAttempt, attempt)
    run(host, 'a', attempt + 1, message)
    host.emit('a', 'turn/end', { turn: attempt + 1, reason: { kind: 'interrupted' } })
    await settle(() => inflight(home).a?.resumeAttempt === attempt)
    await host.stop()
  }

  const exhausted = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => inflight(home).a === undefined)
  assert.equal(exhausted.agentOf('a').calls.length, 0)
})

test('an unconsumed queued resume keeps its exchange and counts only when resent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, {
    turns: {},
    queued: { a: [{ at: Date.now(), args: { toId: 'a', sessionId: 'a', role: 'resume', text: 'continue', resumed: true, resumeAttempt: 1, exchangeId: 'resume-x' } }] },
  })
  const host = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length === 1)
  const [message] = host.agentOf('a').calls
  assert.deepEqual([message.source.exchangeId, message.source.resumeAttempt], ['resume-x', 2])
  await settle(() => inflight(home).a?.resumeAttempt === 2)
})

test('a dispatched but not started recovery keeps its attempt across a quick restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1 } }, queued: {} })
  const first = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => first.agentOf('a').calls.length === 1 && inflight(home).a?.resumeAttempt === 1)
  const firstMessage = first.agentOf('a').calls[0]
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const secondMessage = second.agentOf('a').calls[0]
  assert.deepEqual([secondMessage.source.exchangeId, secondMessage.source.resumeAttempt], [firstMessage.source.exchangeId, 2])
})

test('an already queued recovery is not duplicated or counted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, {
    turns: { a: { botId: 'a', since: 1, resumed: true, resumeAttempt: 1, resumeProgress: false } },
    queued: { a: [{ at: Date.now(), args: { toId: 'a', sessionId: 'a', role: 'resume', text: 'continue', resumed: true, resumeAttempt: 1, exchangeId: 'resume-x' } }] },
  })
  const host = await start(home)
  host.agentOf('a').inbox.nextTurn.push({ source: { exchangeId: 'resume-x' } })
  t.mock.timers.tick(3000)
  await settle(() => inflight(home).a?.resumeAttempt === 1)
  assert.equal(host.agentOf('a').calls.length, 0)
  assert.equal(notes(home).queued.a[0].args.exchangeId, 'resume-x')

  const takenHome = freshHome(t)
  writeInflight(takenHome, {
    turns: { a: { botId: 'a', since: 1, resumed: true, resumeAttempt: 1, resumeProgress: false } },
    queued: { a: [{ at: Date.now(), args: { toId: 'a', sessionId: 'a', role: 'resume', text: 'continue', resumed: true, resumeAttempt: 1, exchangeId: 'resume-taken' } }] },
  })
  const taken = await start(takenHome)
  run(taken, 'a', 2, { content: [{ type: 'text', text: 'continue' }], source: { kind: 'bot', form: 'relay', role: 'resume', resumed: true, resumeAttempt: 1, exchangeId: 'resume-taken' } })
  t.mock.timers.tick(3000)
  await settle(() => inflight(takenHome).a?.resumeAttempt === 1)
  assert.equal(taken.agentOf('a').calls.length, 0)
})

test('reasoning and tool calls are not recovery progress; durable tool results are', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'start work' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await settle(() => inflight(home).a !== undefined)
  await first.stop()

  const host = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => host.agentOf('a').calls.length === 1)
  run(host, 'a', 2, host.agentOf('a').calls[0])
  host.emit('a', 'reasoning/message', { message: { content: [{ type: 'text', text: 'thinking' }] } })
  host.emit('a', 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('a', 'assistant/message', { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inflight(home).a?.resumeProgress, false)
  host.emit('a', 'tool/result', { callId: 'k1' })
  await settle(() => inflight(home).a?.resumeProgress === true)
})

test('legacy resumed notes stop, managed autonomy retains ownership, and normal input resets the chain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1, resumed: true } }, queued: {} })
  const legacy = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => inflight(home).a === undefined)
  assert.equal(legacy.agentOf('a').calls.length, 0)
  await legacy.stop()

  writeInflight(home, { turns: { a: { botId: 'a', since: 1, managedAutonomy: true } }, queued: {} })
  const managed = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => existsSync(join(home, 'inflight.json')))
  assert.equal(managed.agentOf('a').calls.length, 0)
  assert.equal(inflight(home).a.managedAutonomy, true)
  await managed.stop()

  const resetHome = freshHome(t)
  writeInflight(resetHome, { turns: { a: { botId: 'a', since: 1, resumed: true, resumeAttempt: 2, resumeProgress: false } }, queued: {} })
  const reset = await start(resetHome)
  reset.emit('a', 'turn/start', { turn: 2 })
  reset.emit('a', 'user/message', { content: [{ type: 'text', text: 'new work' }], source: { kind: 'user' } })
  await settle(() => inflight(resetHome).a?.resumeAttempt === undefined && inflight(resetHome).a?.resumeProgress === undefined)
  reset.emit('a', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await reset.stop()
  const next = await start(resetHome)
  t.mock.timers.tick(3000)
  await settle(() => next.agentOf('a').calls.length === 1)
  assert.equal(next.agentOf('a').calls[0].source.resumeAttempt, 1)
})

test('a failed agent resolution does not consume a recovery attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  writeInflight(home, { turns: { a: { botId: 'a', since: 1 } }, queued: {} })
  const first = await start(home)
  first.ctx.sessionController.resolveAgent = async () => { throw new Error('temporarily unavailable') }
  t.mock.timers.tick(3000)
  await settle(() => notes(home).queued.a?.length === 1)
  assert.equal(inflight(home).a?.resumeAttempt, undefined)
  assert.equal(notes(home).queued.a[0].args.resumeAttempt, 0)
  assert.equal(first.agentOf('a').calls.length, 0)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.equal(second.agentOf('a').calls[0].source.resumeAttempt, 1)
})

test('completed, failed, and user-stopped resumed turns clear their recovery messages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reasons = [
    { kind: 'completed' },
    { kind: 'error', error: { message: 'failed' } },
    { kind: 'aborted', reason: { kind: 'user' } },
  ]
  for (const reason of reasons) {
    const home = freshHome(t)
    writeInflight(home, {
      turns: { a: { botId: 'a', since: 1, resumed: true, resumeAttempt: 1, resumeProgress: false } },
      queued: { a: [{ at: Date.now(), args: { toId: 'a', sessionId: 'a', role: 'resume', text: 'continue', resumed: true, resumeAttempt: 1, exchangeId: 'resume-stop' } }] },
    })
    const host = await start(home)
    host.emit('a', 'turn/end', { turn: 1, reason })
    await settle(() => inflight(home).a === undefined && (notes(home).queued.a ?? []).length === 0)
    t.mock.timers.tick(3000)
    assert.equal(host.agentOf('a').calls.length, 0)
    await host.stop()
  }
})

test('a request cut off by a restart goes on under the same exchange; own-chat work resumes in the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1 && second.agentOf('a').calls.length === 1)
  const request = second.agentOf('b').calls[0]
  assert.deepEqual([request.source.role, request.source.exchangeId, request.source.senderSessionId, request.source.resumed], ['request', 'x1', 'a', true])
  assert.match(text(request), /^\[Message from Chief · DeepSeek Harness restarted while you were working on it\]/)
  const own = second.agentOf('a').calls[0]
  assert.deepEqual([own.source.role, own.source.resumed], ['resume', true])
  assert.match(text(own), /^\[DeepSeek Harness restarted while you were working\]/)
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.exchanges.length, 0)
})

test('when only DS Bot restarts, a turn still running or finished meanwhile is not picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  // DSH went on: Writer is still at work, and Chief's turn ends before the pick-up.
  const second = await start(home)
  second.agentOf('b').status = 'running'
  second.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  // One read per check: two reads can see the old notes and the cleared ones.
  await settle(() => {
    const noted = inflight(home)
    return noted.b?.trigger?.exchangeId === 'x1' && noted.a === undefined
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])

  // Writer's turn stays noted, so a real restart still picks it up.
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 1)
  assert.deepEqual([third.agentOf('b').calls[0].source.exchangeId, third.agentOf('a').calls.length], ['x1', 0])
})

test('a finished turn leaves nothing to pick up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => Object.keys(inflight(home)).length === 0 && existsSync(join(home, 'inflight.json')))
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a turn DSH stops as it shuts down stays noted; one the user stops does not', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  run(host, 'b', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => inflight(home).a !== undefined && inflight(home).b === undefined)
})

test('a message a shutdown cancelled is sent again once; one still waiting, taken up or withdrawn is not', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const send = message => first.tool('message_bot', { to: 'Writer', message, when: 'queue' }, 'a')
  await send('Draft the plan')
  await send('Check the numbers')
  await send('Read the notes')
  await send('Never mind')
  const [plan, numbers, notesMessage, withdrawn] = first.agentOf('b').calls
  // Taken up by a turn, or withdrawn while DS Bot runs (the user stopped the Bot).
  first.emit('b', 'user/message', { content: notesMessage.content, source: notesMessage.source })
  for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ message: withdrawn })
  await settle(() => (notes(home).queued.b ?? []).length === 2)
  await first.stop()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  // A hard stop keeps the inbox: that message runs when the Session wakes.
  second.agentOf('b').inbox.nextTurn.push(numbers)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.deepEqual([again.source.exchangeId, again.source.role, text(again)], [plan.source.exchangeId, 'request', text(plan)])
  // The resend is the same exchange, not a new one.
  assert.equal((await second.call('exchange', { a: 'a', b: 'b' })).value.length, 4)
})

const WRITTEN = 'Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>'

test('a tool call written as text gets one more turn on the same round slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Written again: the text goes on without the call.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Checking now.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('in its own chat, a Bot that wrote a tool call as text is asked to make it', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'b', 1, { content: [{ type: 'text', text: 'move the docs' }], source: { kind: 'user' } })
  // A call made for real, with or without text around it, is no retry.
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const retry = host.agentOf('b').calls[0]
  assert.deepEqual([retry.source.role, retry.source.retried], ['retry', true])
  assert.match(text(retry), /^\[Your last reply wrote a tool call as text, so nothing ran\]/)
})

test('a written tool call is told apart from text about one', () => {
  assert.equal(writesToolCall(WRITTEN), true)
  assert.equal(writesToolCall('<function=read>\n<parameter=path>a.md</parameter></function>'), true)
  assert.equal(writesToolCall('Models such as Step write `<tool_call>` tags in their template.'), false)
  assert.equal(writesToolCall(undefined), false)
  assert.equal(stripWrittenCalls(WRITTEN), 'Checking now.')
})
