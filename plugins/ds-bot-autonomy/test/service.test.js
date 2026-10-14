import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAutonomyService } from '../src/service.js'
import { responsibilitySchema, workItemSchema } from '../src/domain.js'

const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate) }
const text = value => [{ type: 'text', text: value }]

function deferred() {
  let resolve
  const promise = new Promise(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

function harness({ failWorkPut, holdWorkPut } = {}) {
  const rows = { responsibilities: new Map(), work_items: new Map() }
  const listeners = new Map()
  const agentsById = new Map()
  const current = new Map()
  const owners = new Map()
  const deliveries = []
  let attached
  let initiator
  let goalNumber = 0
  const schemas = { responsibilities: responsibilitySchema, work_items: workItemSchema }
  const storageDomain = {
    async open() {
      return {
        table(name) {
          const values = rows[name]
          return {
            get: id => values.get(id),
            entries: () => [...values.entries()],
            async put(id, value) {
              if (name === 'work_items' && holdWorkPut) await holdWorkPut(id, value)
              if (name === 'work_items' && failWorkPut?.(id, value)) throw new Error('synthetic storage write failure')
              const parsed = schemas[name].parse(value)
              values.set(id, parsed)
              return parsed
            },
            async update(id, change) {
              const previous = values.get(id)
              if (previous === undefined) return undefined
              return this.put(id, change(previous))
            },
            async delete(id) { return values.delete(id) },
          }
        },
        async close() {},
      }
    },
  }
  const agentFor = (id, status) => {
    if (agentsById.has(id)) {
      const agent = agentsById.get(id)
      if (status !== undefined) agent.status = status
      return agent
    }
    const events = []
    const agent = {
      id,
      status: status ?? 'idle',
      inbox: { nextStep: [], nextTurn: [] },
      session: {
        id,
        events,
        snapshotEvents: () => [...events],
      },
      cancel() { this.status = 'idle'; this.cancelled = true },
    }
    agentsById.set(id, agent)
    return agent
  }
  const author = agentFor('s-chief', 'running')
  author.session.events.push(
    { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 101, data: { id: 'human-1', source: { kind: 'user' }, content: text('Please do this work') } },
  )
  current.set('chief', { botId: 'chief', sessionId: 's-chief' })
  current.set('writer', { botId: 'writer', sessionId: 's-writer' })
  owners.set('s-chief', { botId: 'chief' })
  owners.set('s-writer', { botId: 'writer' })
  const writer = agentFor('s-writer')
  const agents = {
    get: id => agentsById.get(id),
    roots: () => [...agentsById.values()],
    currentInitiator: () => initiator,
  }
  const goalViews = new Map()
  const goalCalls = []
  const goals = {
    get(agent) { return goalViews.get(agent.id) },
    create(agent, request) {
      const goal = { id: `goal-${++goalNumber}`, revision: 1, objective: request.objective, phase: 'active', maxGoalRounds: request.maxGoalRounds, roundsStarted: 0, activation: 'armed' }
      goalViews.set(agent.id, goal)
      goalCalls.push({ sessionId: agent.id, request, goal })
      return { ...goal }
    },
    resume(agent, ref) {
      const prior = goalViews.get(agent.id)
      assert.equal(prior.id, ref.id)
      const next = { ...prior, revision: prior.revision + 1, phase: 'active', activation: 'armed' }
      delete next.blockedReason
      goalViews.set(agent.id, next)
      return { ...next }
    },
    block(agent, ref, reason) {
      const prior = goalViews.get(agent.id)
      assert.equal(prior.id, ref.id)
      const next = { ...prior, revision: prior.revision + 1, phase: 'blocked', blockedReason: reason, activation: 'disarmed' }
      goalViews.set(agent.id, next)
      return { ...next }
    },
    disarm(agent) {
      const prior = goalViews.get(agent.id)
      if (prior !== undefined) goalViews.set(agent.id, { ...prior, activation: 'disarmed' })
      return goalViews.get(agent.id)
    },
  }
  const host = {
    version: 1,
    async ready() {},
    writable: () => true,
    target(botId, roomId) {
      const value = current.get(botId)
      if (value === undefined || (roomId !== undefined && value.roomId !== roomId)) throw new Error('unknown target')
      return Object.freeze({ ...value, ...(roomId === undefined ? {} : { roomId }) })
    },
    owner(sessionId) { return owners.get(sessionId) },
    async resolve(target) { return agentFor(target.sessionId) },
    async deliver(request) {
      deliveries.push(request)
      return { state: 'receipt', receipt: { exchangeId: request.id, messageId: `m-${request.id}`, sessionId: request.target.sessionId } }
    },
    async readDelivery() { return { state: 'missing' } },
    attach(extension) { attached = extension; return () => { if (attached === extension) attached = undefined } },
  }
  const service = createAutonomyService({}, { host, agents, goals, storageDomain })
  const ctx = {
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => listeners.set(name, list.filter(candidate => candidate !== listener))
    },
    tools: { register() { return () => {} } },
  }
  const emit = (agent, type, data) => {
    const seq = agent.session.events.length + 1
    const event = { type, seq, time: 200 + seq, data }
    agent.session.events.push(event)
    for (const listener of listeners.get('session/event') ?? []) listener(agent.session, event)
    return event
  }
  return {
    service, ctx, listeners, author, writer, agentsById, current, owners, rows, goalViews, goalCalls, deliveries,
    async start() { await service.initialize(); service.install(ctx) },
    async dispose() { await service.dispose() },
    emit,
    useAuthor() { initiator = author },
    extension: () => attached,
    async submit(input = {}) {
      initiator = author
      const result = await service.api.submit({ botId: 'writer', objective: 'Write a short report', acceptance: 'The report has the requested facts', allowedScope: 'the saved source pack', ...input, origin: { kind: 'goal' }, returnAddress: { botId: 'attacker' } }, author)
      await flush()
      return result
    },
  }
}

test('a task gets one native Goal and its total round limit is preserved across a part move', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  const item = await h.submit({ maxGoalRounds: 3 })
  assert.equal(h.goalCalls.length, 1)
  assert.equal(h.goalCalls[0].request.maxGoalRounds, 3)
  assert.equal(item.origin.kind, 'human')
  assert.equal(item.returnAddress.botId, 'chief')

  const first = h.goalViews.get('s-writer')
  h.goalViews.set('s-writer', { ...first, roundsStarted: 1 })
  h.emit(h.writer, 'user/message', { content: text('round 1'), source: { kind: 'goal', goalId: first.id, revision: first.revision, round: 1 } })
  await flush()
  assert.equal((await h.service.api.get(item.id)).consumedRounds, 1)

  const token = await h.extension().beginPartMove({ botId: 'writer', fromSessionId: 's-writer' })
  assert.equal(h.goalViews.get('s-writer').activation, 'disarmed')
  const nextAgent = h.agentsById.has('s-writer-2') ? h.agentsById.get('s-writer-2') : undefined
  const agent = nextAgent ?? (() => {
    const events = []
    const value = { id: 's-writer-2', status: 'idle', inbox: { nextStep: [], nextTurn: [] }, session: { id: 's-writer-2', events, snapshotEvents: () => [...events] }, cancel() {} }
    h.agentsById.set(value.id, value)
    return value
  })()
  h.current.set('writer', { botId: 'writer', sessionId: agent.id })
  h.owners.set(agent.id, { botId: 'writer' })
  await h.extension().finishPartMove(token, { botId: 'writer', fromSessionId: 's-writer', toSessionId: agent.id })
  await flush()
  assert.equal(h.goalCalls.length, 2)
  assert.equal(h.goalCalls[1].request.maxGoalRounds, 2)
  assert.equal((await h.service.api.get(item.id)).consumedRounds, 1)
})

test('ask_user blocks the owned Goal and a matching saved answer resumes that Goal', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  const item = await h.submit()
  const question = { id: 'q-1', question: 'Which title?', options: [{ label: 'A' }, { label: 'B' }] }
  await h.extension().questionOpened('s-writer', question)
  assert.equal((await h.service.api.get(item.id)).waitReason, 'question')
  assert.equal(h.goalViews.get('s-writer').phase, 'blocked')
  assert.equal(await h.extension().questionAnswered('s-writer', question, { selected: ['A'] }), true)
  const answer = JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user', questions: [{ id: 'q-1' }], answers: [{ id: 'q-1', selected: ['A'] }] })
  h.emit(h.writer, 'user/message', { content: text(answer), source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' } })
  await flush()
  assert.equal((await h.service.api.get(item.id)).status, 'active')
  assert.equal(h.goalViews.get('s-writer').phase, 'active')
})

test('a stop fences late turn results and does not deliver a stopped task', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  const item = await h.submit()
  h.writer.status = 'running'
  h.emit(h.writer, 'turn/start', { turn: 1 })
  assert.equal((await h.service.api.stop(item.id, h.author)).status, 'stopped')
  const before = h.deliveries.length
  assert.equal(h.extension().claimTurnResult('s-writer', { turn: 1, texts: ['late result'] }), true)
  await flush()
  assert.equal(h.deliveries.length, before)
  assert.equal((await h.service.api.get(item.id)).status, 'stopped')
})

test('scoped and public Stop fence owned work before their durable writes finish', async t => {
  const holds = new Map()
  const h = harness({
    holdWorkPut(id, item) {
      const hold = holds.get(id)
      if (item.status === 'stopped' && hold !== undefined) {
        hold.entered.resolve()
        return hold.release.promise
      }
    },
  })
  await h.start()
  t.after(h.dispose)
  h.current.set('other', { botId: 'other', sessionId: 's-other' })
  h.owners.set('s-other', { botId: 'other' })
  const other = await h.submit({ botId: 'other', objective: 'Other Bot work' })
  const item = await h.submit()
  const queued = await h.submit({ objective: 'Queued writer work' })
  assert.equal((await h.service.api.get(other.id)).status, 'active')
  assert.equal((await h.service.api.get(queued.id)).status, 'queued')

  h.emit(h.writer, 'turn/start', { turn: 2 })
  const goal = h.goalViews.get(h.writer.id)
  const completedGoal = { ...goal, revision: goal.revision + 1, phase: 'complete', activation: 'disarmed' }
  h.goalViews.set(h.writer.id, completedGoal)
  h.emit(h.writer, 'goal/change', { operation: 'complete', goal: completedGoal })
  await flush()
  assert.equal((await h.service.api.get(item.id)).status, 'complete')

  const holdStopWrite = id => {
    const hold = { entered: deferred(), release: deferred() }
    holds.set(id, hold)
    return hold
  }
  const scopeHold = holdStopWrite(item.id)
  const stopping = h.extension().beforeStop({ botId: 'writer' })
  assert.equal(h.goalViews.get(h.writer.id).activation, 'disarmed')
  await scopeHold.entered.promise

  const middleware = h.listeners.get('agent/pre-step')[0]
  assert.deepEqual(await middleware({ agent: h.writer }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  const goalCallsBeforePump = h.goalCalls.length
  for (const listener of h.listeners.get('agent/status') ?? []) listener({ agent: h.writer })
  await flush()
  assert.equal(h.goalCalls.length, goalCallsBeforePump)
  assert.equal(h.extension().claimTurnResult(h.writer.id, { turn: 2, texts: ['Raced final result'] }), true)
  await flush()
  assert.equal(h.deliveries.length, 0)
  assert.equal((await h.service.api.get(item.id)).status, 'complete')
  assert.equal((await h.service.api.get(queued.id)).status, 'queued')
  assert.equal((await h.service.api.get(other.id)).status, 'active')

  scopeHold.release.resolve()
  holds.delete(item.id)
  await stopping
  assert.equal((await h.service.api.get(item.id)).status, 'stopped')
  assert.equal((await h.service.api.get(queued.id)).status, 'stopped')
  assert.equal(h.deliveries.length, 0)

  h.emit(h.writer, 'turn/end', { turn: 2, reason: { kind: 'stop' } })
  const resumed = await h.service.api.resume(item.id, h.author)
  assert.equal(resumed.status, 'active')
  assert.equal((await middleware({ agent: h.writer }, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
  assert.equal((await h.service.api.get(other.id)).status, 'active')

  const publicHold = holdStopWrite(item.id)
  const publicStop = h.service.api.stop(item.id, h.author)
  await publicHold.entered.promise
  assert.equal((await h.service.api.get(item.id)).status, 'active')
  assert.deepEqual(await middleware({ agent: h.writer }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  publicHold.release.resolve()
  holds.delete(item.id)
  await publicStop
  assert.equal((await h.service.api.get(item.id)).status, 'stopped')
  assert.equal((await h.service.api.get(other.id)).status, 'active')
})

test('unmanaged Bot turns stay on the legacy result path', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  h.emit(h.writer, 'turn/start', { turn: 7 })
  assert.equal(h.extension().claimTurnResult('s-writer', { turn: 7, texts: ['ordinary reply'] }), false)
})

test('busy and foreign Goals queue, scoped stop preserves other Bots and read-only access', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  h.writer.status = 'running'
  const first = await h.submit()
  assert.equal((await h.service.api.get(first.id)).status, 'queued')
  assert.equal(h.goalCalls.length, 0)
  await h.extension().beforeStop({ botId: 'writer' })
  assert.equal((await h.service.api.get(first.id)).status, 'stopped')
  assert.equal((await h.extension().handleApi('autonomy-get', { id: first.id })).id, first.id)
  h.writer.status = 'idle'
  h.goalViews.set(h.writer.id, { id: 'foreign', revision: 1, phase: 'active' })
  const foreign = await h.submit()
  assert.equal((await h.service.api.get(foreign.id)).status, 'queued')
  assert.equal(h.goalViews.get(h.writer.id).id, 'foreign')
  await h.extension().beforeStop({ botId: 'writer' })
  h.goalViews.delete(h.writer.id)
  const next = await h.submit()
  assert.equal((await h.service.api.get(next.id)).status, 'active')
})

test('round persistence failure closes only the managed admission', async t => {
  let fail = false
  const h = harness({ failWorkPut: (_id, item) => fail && item.consumedRounds === 1 })
  await h.start()
  t.after(h.dispose)
  const item = await h.submit()
  const goal = h.goalViews.get(h.writer.id)
  h.goalViews.set(h.writer.id, { ...goal, roundsStarted: 1 })
  fail = true
  h.emit(h.writer, 'user/message', { content: text('round'), source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 } })
  await flush()
  const middleware = h.listeners.get('agent/pre-step')[0]
  assert.deepEqual(await middleware({ agent: h.writer }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  assert.equal(h.goalViews.get(h.writer.id).activation, 'disarmed')
  assert.equal((await h.service.api.get(item.id)).consumedRounds, 0)
  assert.equal((await middleware({ agent: h.author }, async () => ({ kind: 'enter', messages: [] }))).kind, 'enter')
  fail = false
})

test('requested shared resources stay claimed while a question waits and across a part rollback', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  const item = await h.submit({ resources: ['computer:shared', 'path:J:/task/source'] })
  await h.extension().questionOpened(h.writer.id, { id: 'question', question: 'Choose' })
  const token = await h.extension().beginPartMove({ botId: 'writer', fromSessionId: h.writer.id })
  await h.extension().abortPartMove(token, { botId: 'writer', fromSessionId: h.writer.id })
  const saved = await h.service.api.get(item.id)
  assert.equal(saved.waitReason, 'question')
  assert.ok(saved.resources.includes('computer:shared'))
  assert.ok(saved.resources.some(resource => resource.startsWith('path:')))
  assert.equal(saved.consumedRounds, 0)
})

test('trusted mixed schedule batches consume bound occurrences once and move bindings', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  h.useAuthor()
  const responsibility = await h.service.api.responsibilities.create({ botId: 'writer', objective: 'Saved objective', acceptance: 'Saved acceptance', allowedScope: 'Saved scope' }, h.author)
  h.service.setSchedule({ create: async () => ({ id: 'schedule-old' }) })
  await h.service.api.schedules.create(responsibility.id, {}, h.author)
  await h.extension().scheduleMoved({ oldId: 'schedule-old', newId: 'schedule-new' })
  const payload = [
    { schedule_id: 'schedule-new', occurrence_at: '2030-01-01', reminder_prompt: 'Bound prompt' },
    { schedule_id: 'foreign', occurrence_at: '2030-01-01', reminder_prompt: 'Preserve prompt' },
  ]
  const message = { role: 'user', id: 'batch', source: { kind: 'schedule' }, content: text('[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ' + JSON.stringify(payload)) }
  const middleware = h.listeners.get('agent/pre-step')[0]
  for (let i = 0; i < 2; i++) {
    const decision = await middleware({ agent: h.writer }, async () => ({ kind: 'enter', messages: [message] }))
    assert.equal(decision.kind, 'enter')
    assert.match(decision.messages[0].content[0].text, /Preserve prompt/)
    assert.doesNotMatch(decision.messages[0].content[0].text, /Bound prompt/)
  }
  const work = await h.service.api.list()
  assert.equal(work.length, 1)
  assert.equal(work[0].objective, 'Saved objective')
  assert.equal(work[0].origin.scheduleId, 'schedule-new')
})

test('public mutations cannot replace native human authority with supplied options', async t => {
  const h = harness()
  await h.start()
  t.after(h.dispose)
  h.author.status = 'idle'
  await assert.rejects(h.service.api.submit({ botId: 'writer', objective: 'Unapproved', acceptance: 'Unapproved' }, h.author, { api: true }), /live running Session/)
  await assert.rejects(h.service.api.responsibilities.create({ botId: 'writer', objective: 'Unapproved', acceptance: 'Unapproved', allowedScope: 'All' }, h.author, { authorizationRef: { sessionId: 'fake' } }), /live running Session/)
  assert.equal((await h.service.api.list()).length, 0)
})
