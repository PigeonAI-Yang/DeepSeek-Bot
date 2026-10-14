import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Goals from '@deepseek-ai/dsh-goal'
import * as Driver from '@deepseek-ai/dsh-goal-round-driver'
import * as GoalTools from '@deepseek-ai/dsh-tool-goal'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Autonomy from '../index.js'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Schedule, { renderRecurringReminderBatchFraming } from '@deepseek-ai/dsh-schedule'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Pwsh from '@deepseek-ai/dsh-pwsh-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh'
import { pathToFileURL } from 'node:url'
import { dsBotSource } from './resolve-harness.mjs'

const { install: installSchedules } = await import(pathToFileURL(join(dsBotSource, 'src/host/schedules.js')).href)
const { install: installHost } = await import(pathToFileURL(join(dsBotSource, 'src/host/autonomy-host.js')).href)

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate) }
const until = async (predicate, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Isolated native workflow did not reach its expected state')
}

async function nativeHarness(t, { schedule = false, background = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ds-autonomy-native-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); await fiber.await(); return fiber }
  for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Storage]) await mount(plugin)
  await mount(JsonStorage, { root })
  await mount(StorageDomain, { backend: 'json' })
  if (schedule) await mount(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await mount(AgentLoop)
  await mount(Goals)
  await mount(GoalTools)
  await mount(Driver)
  if (background) {
    await mount(Jobs)
    await mount(JobTools)
    await mount(Subprocess)
    await mount(Pwsh, { cwd: root })
    await mount(ShellEnv)
    await mount(PwshTool)
  }
  if (schedule) {
    ctx.provide('sessionController', { resolveAgent: async id => ({ agent: ctx.agents.get(id) }) })
    await mount(Schedule)
  }
  let author
  let writer
  const deliveries = []
  const rt = {
    ctx, state: { exchanges: [], bots: {}, rooms: {} }, warn: () => {}, pastOwners: new Map(), load: async () => {}, readOnly: () => undefined,
    botOf: id => rt.chatOwners.has(id + '-session') ? { id, name: id } : undefined,
    roomOf: () => undefined,
    chatOf: id => id + '-session',
    chatOwners: new Map(), groupOwners: new Map(), ensureCapabilities: async () => {},
    resolveAgent: async id => ctx.agents.get(id),
    deliver: async request => {
      const agent = ctx.agents.get(request.sessionId)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: request.text }], source: { kind: 'bot', role: request.role, exchangeId: request.exchangeId, senderSessionId: request.fromId, ...(request.replyTo ? { replyTo: request.replyTo } : {}) } }))
    },
  }
  await mount({ apply: () => installHost(rt) })
  if (schedule) await mount({ apply: () => installSchedules(rt) })
  const fiber = await mount(Autonomy)
  await until(() => ctx.get('dsBotAutonomy') !== undefined)
  author = await ctx.agentLoop.create('chief-session', { provider: 'offline', model: 'mock' })
  writer = await ctx.agentLoop.create('writer-session', { provider: 'offline', model: 'mock' })
  rt.chatOwners.set(author.id, 'chief')
  rt.chatOwners.set(writer.id, 'writer')
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source?.kind === 'bot' && event.data.source?.role === 'report') deliveries.push(event.data)
  })
  // DS Bot owns this turn-result callback in production, before the autonomy listener.
  ctx.on('session/event', (session, event) => {
    if (rt.chatOwners.has(session.id) && event.type === 'turn/end') rt.autonomyClaimTurnResult(session.id, { turn: event.data.turn, reason: event.data.reason })
  }, { prepend: true })
  return { ctx, fiber, author, writer, deliveries, rt, settle, async addBot(id) { const agent = await ctx.agentLoop.create(id + '-session', { provider: 'offline', model: 'mock' }); rt.chatOwners.set(agent.id, id); return agent } }
}

class OfflineModel extends LlmAdapter {
  constructor(run) { super(); this.run = run }
  async *stream(options) {
    const block = await this.run(options)
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
  }
}

test('native background process continues while this same Bot replies to a new human message', async t => {
  const h = await nativeHarness(t, { background: true })
  let calls = 0
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async () => {
    calls++
    if (calls === 1) return { type: 'tool-call', id: 'background', name: 'pwsh', arguments: { command: 'Start-Sleep -Seconds 6; Write-Output "finished"', run_in_background: true, description: 'Run isolated background responsiveness check' } }
    return { type: 'text', text: calls === 2 ? 'The job is still running.' : 'I received your new message while the job continues.' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Start isolated work' }], source: { kind: 'user' } }))
  await h.author.whenIdle()
  const job = h.ctx.jobs.list(h.author.id).find(job => job.status === 'running')
  assert.ok(job, 'the native process must still be running after the conversational turn')
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Can you respond now?' }], source: { kind: 'user' } }))
  await h.author.whenIdle()
  const messages = h.author.session.snapshotEvents().filter(event => event.type === 'assistant/message')
  assert.ok(messages.some(event => event.data.message.content.some(block => block.type === 'text' && block.text.includes('received your new message'))))
  assert.equal(h.ctx.jobs.get(job.id, h.author.id).status, 'running', 'answering the user must not stop or await the process')
  await until(() => h.ctx.jobs.get(job.id, h.author.id).status === 'completed', 800)
})

test('managed Goal waits for the background job, answers a human, and completes after its notice', async t => {
  const h = await nativeHarness(t, { background: true })
  let item
  let started = false
  let collected = false
  let attempts = 0
  h.ctx.on('session/event', (session, event) => {
    if (session.id === h.writer.id && event.type === 'tool/result') {
      const text = event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
      if (text.startsWith('Error')) console.error('isolated responsive tool error:', text)
    }
  })
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.type === 'text' && block.text === 'Assign responsive work'))) {
      item = (await h.ctx.dsBotAutonomy.list())[0]
      if (!item) return { type: 'tool-call', id: 'submit-responsive', name: 'autonomy_submit_work', arguments: { botId: 'writer', objective: 'Finish the background check while remaining responsive', acceptance: 'Background command completed and human status answered', maxGoalRounds: 5 } }
      return { type: 'text', text: 'Assigned' }
    }
    if (!started) {
      started = true
      return { type: 'tool-call', id: 'managed-background', name: 'pwsh', arguments: { command: 'Start-Sleep -Seconds 3; Write-Output "finished"', run_in_background: true, description: 'Run isolated managed background work' } }
    }
    const running = h.ctx.jobs.list(h.writer.id).some(job => job.status === 'running')
    if (running) return { type: 'text', text: 'I can answer you while the background task continues.' }
    const goal = h.ctx.goals.get(h.writer)
    const events = h.writer.session.snapshotEvents()
    const start = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
    const canComplete = events.some(event => event.seq > start && event.type === 'user/message' && (event.data.source?.kind === 'user' || event.data.source?.kind === 'goal'))
    if (!collected) {
      collected = true
      const job = h.ctx.jobs.list(h.writer.id).find(job => job.status === 'completed')
      return { type: 'tool-call', id: 'read-responsive-result', name: 'job_output', arguments: { job_id: job.id, wait: false } }
    }
    if (goal.phase === 'active' && !canComplete) return { type: 'text', text: 'Background output collected; ready to verify the task.' }
    if (goal.phase === 'active') {
      if (++attempts > 2) throw new Error('Isolated responsive completion was rejected repeatedly')
      return { type: 'tool-call', id: `complete-responsive-${attempts}`, name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
    }
    return { type: 'text', text: 'Background result verified.' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Assign responsive work' }], source: { kind: 'user' } }))
  await until(() => h.ctx.jobs.list(h.writer.id).some(job => job.status === 'running'), 400).catch(error => {
    const events = h.writer.session.snapshotEvents().filter(event => ['assistant/message', 'tool/result', 'turn/end'].includes(event.type))
    throw new Error(`${error.message}: ${JSON.stringify(events.map(event => ({ type: event.type, reason: event.data.reason, content: event.data.message?.content })))}`)
  })
  await h.writer.whenIdle()
  assert.equal(h.ctx.goals.get(h.writer).activation, 'disarmed')
  h.writer.followup(createUserMessage({ content: [{ type: 'text', text: 'Tell me the current status' }], source: { kind: 'user' } }))
  await h.writer.whenIdle()
  assert.ok(h.ctx.jobs.list(h.writer.id).some(job => job.status === 'running'))
  assert.ok(h.writer.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('I can answer you'))))
  await until(async () => item && (await h.ctx.dsBotAutonomy.get(item.id)).status === 'complete', 800)
  const saved = await h.ctx.dsBotAutonomy.get(item.id)
  assert.ok(saved.consumedRounds < saved.maxGoalRounds, 'background waiting must not burn the Goal budget')
})

test('Cordis plugin loads with native storage and the native driver completes two rounds', async t => {
  const h = await nativeHarness(t)
  let item
  let writerCalls = 0
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    const human = options.messages.some(message => message.content?.some(block => block.type === 'text' && block.text === 'Authorize saved work'))
    if (human) {
      item = (await h.ctx.dsBotAutonomy.list())[0]
      if (!item) return { type: 'tool-call', id: 'submit-call', name: 'autonomy_submit_work', arguments: { botId: 'writer', objective: 'Produce the result', acceptance: 'Two native rounds, final evidence', maxGoalRounds: 2 } }
      return { type: 'text', text: 'Authorized' }
    }
    writerCalls++
    const goal = h.ctx.goals.get(h.writer)
    if (goal.roundsStarted === 1) return { type: 'text', text: 'First round evidence' }
    if (goal.phase === 'active') return { type: 'tool-call', id: 'complete-call', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
    return { type: 'text', text: 'Final evidence after completion' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize saved work' }], source: { kind: 'user' } }))
  await until(() => h.deliveries.length === 1)
  await h.writer.whenIdle()
  const saved = await h.ctx.dsBotAutonomy.get(item.id)
  assert.equal(saved.status, 'complete')
  assert.equal(saved.consumedRounds, 2)
  assert.match(saved.result, /Final evidence after completion/)
  assert.equal(writerCalls, 3)
  const rounds = h.writer.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round > 0)
  assert.deepEqual(rounds.map(event => event.data.source.round), [1, 2])
  assert.ok(h.ctx.tools.schemas(h.writer).some(schema => schema.name === 'autonomy_submit_work'))
  await h.fiber.dispose()
  await settle()
  assert.equal(h.ctx.get('dsBotAutonomy'), undefined)
  assert.throws(() => h.rt.autonomyEndpoint('autonomy-get', {}), /not available/)
  assert.equal(h.rt.autonomyClaimTurnResult(h.writer.id, { turn: 99 }), false)
  assert.equal(h.author.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1)
})

test('native ask_user waits for matching answer, then completes through the same Goal driver', async t => {
  const h = await nativeHarness(t)
  let question = { id: 'saved-question', question: 'Choose the title' }
  let asked = false
  let item
  h.ctx.tools.register({
    name: 'ask_user', description: 'Isolated question adapter', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      await h.rt.autonomyQuestionOpened(exec.agent.id, question)
      exec.concludeTurn()
      return 'Waiting for the user'
    },
  })
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.text === 'Authorize question work'))) {
      item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Choose a title', acceptance: 'Use the user answer', maxGoalRounds: 3 }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    if (!asked) { asked = true; return { type: 'tool-call', id: 'ask-call', name: 'ask_user', arguments: {} } }
    const goal = h.ctx.goals.get(h.writer)
    if (goal.phase === 'complete') return { type: 'text', text: 'Completed with the matching answer' }
    if (goal.roundsStarted >= 2) return { type: 'tool-call', id: 'finish-call', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
    return { type: 'text', text: 'Answer accepted; continuing the saved task' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize question work' }], source: { kind: 'user' } }))
  await until(async () => item && (await h.ctx.dsBotAutonomy.get(item.id)).waitReason === 'question')
  await h.writer.whenIdle()
  const goalId = h.ctx.goals.get(h.writer).id
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.ctx.goals.get(h.writer).phase, 'blocked')
  assert.equal(await h.rt.autonomyQuestionAnswered(h.writer.id, { ...question, id: 'unrelated' }, { selected: ['A'] }), false)
  assert.equal(await h.rt.autonomyQuestionAnswered(h.writer.id, question, { selected: ['A'] }), true)
  h.writer.followup(createUserMessage({
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user', questions: [{ id: question.id }], answers: [{ id: question.id, selected: ['A'] }] }) }],
    source: { kind: 'user-question-reply', callId: 'ask-call', outcome: 'answered' },
  }))
  await until(() => h.deliveries.length === 1)
  assert.equal(h.ctx.goals.get(h.writer).id, goalId)
  assert.equal((await h.ctx.dsBotAutonomy.get(item.id)).status, 'complete')
})

test('native child result resumes only its parent exchange and the parent delivers integrated acceptance', async t => {
  const h = await nativeHarness(t)
  const childAgent = await h.addBot('child')
  let item
  let delegated = false
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.text === 'Authorize delegation'))) {
      item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Integrate child evidence', acceptance: 'Child report integrated into original result', maxGoalRounds: 4 }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    const isChild = options.messages.some(message => message.source?.kind === 'goal' && message.content?.some(block => block.text.includes('Child evidence objective')))
    const agent = isChild ? childAgent : h.writer
    const goal = h.ctx.goals.get(agent)
    if (!isChild && !delegated) {
      delegated = true
      return { type: 'tool-call', id: 'delegate-call', name: 'autonomy_delegate_work', arguments: { botId: 'child', objective: 'Child evidence objective', acceptance: 'Return the measured fact', maxGoalRounds: 2 } }
    }
    if (goal.phase === 'complete') return { type: 'text', text: isChild ? 'Measured child evidence' : 'Integrated measured child evidence; original acceptance met' }
    if (!isChild && goal.roundsStarted === 1) return { type: 'text', text: 'Integrating the matched child result' }
    return { type: 'tool-call', id: isChild ? 'child-complete' : 'parent-complete', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize delegation' }], source: { kind: 'user' } }))
  await until(() => h.deliveries.length === 1)
  const work = await h.ctx.dsBotAutonomy.list()
  assert.equal(work.length, 2)
  const parent = await h.ctx.dsBotAutonomy.get(item.id)
  const child = work.find(work => work.parentWorkItemId === item.id)
  assert.equal(parent.status, 'complete')
  assert.equal(child.status, 'complete')
  assert.match(parent.result, /Integrated measured child evidence/)
  assert.equal(child.returnAddress.sessionId, h.writer.id)
  assert.equal(parent.returnAddress.sessionId, h.author.id)
  assert.equal(child.dependencyExchangeId, parent.dependencyExchangeId)
})

test('native user cancellation fences late output and requires explicit human resume', async t => {
  const h = await nativeHarness(t)
  let item
  let release
  let entered = false
  let resumed = false
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    const texts = options.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text')
    if (texts.some(block => block.text === 'Authorize cancellable work')) {
      if (texts.some(block => block.text === 'Explicitly resume the stopped work')) {
        if (!resumed) { resumed = true; await h.ctx.dsBotAutonomy.resume(item.id, h.author) }
      } else item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Cancellable work', acceptance: 'Final accepted result', maxGoalRounds: 3 }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    if (!entered) {
      entered = true
      await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }) })
      return { type: 'text', text: 'Late result must not be delivered' }
    }
    const goal = h.ctx.goals.get(h.writer)
    if (goal.phase === 'complete') return { type: 'text', text: 'Resumed work completed' }
    return { type: 'tool-call', id: 'resumed-complete', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize cancellable work' }], source: { kind: 'user' } }))
  await until(() => entered)
  h.writer.cancel({ kind: 'user' })
  release()
  await h.writer.whenIdle()
  await until(async () => (await h.ctx.dsBotAutonomy.get(item.id)).status === 'stopped')
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.ctx.goals.get(h.writer).activation, 'disarmed')
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Explicitly resume the stopped work' }], source: { kind: 'user' } }))
  await until(() => h.deliveries.length === 1)
  const final = await h.ctx.dsBotAutonomy.get(item.id)
  assert.equal(final.status, 'complete')
  assert.equal(final.consumedRounds, 2)
  assert.equal(final.maxGoalRounds, 3)
  assert.doesNotMatch(final.result, /Late result/)
})

test('native schedules persist binding moves and trusted mixed batch occurrence deduplication', async t => {
  const h = await nativeHarness(t, { schedule: true })
  const fresh = await h.addBot('fresh')
  let responsibility
  let record
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.text === 'Authorize a recurring duty'))) {
      if (!responsibility) {
        responsibility = await h.ctx.dsBotAutonomy.responsibilities.create({ botId: 'writer', objective: 'Saved recurring objective', acceptance: 'Saved acceptance', allowedScope: 'Saved sources' }, h.author)
        record = await h.ctx.dsBotAutonomy.schedules.create(responsibility.id, { title: 'Saved duty', prompt: 'Bound trigger', every_seconds: 3600 }, h.author)
      }
      return { type: 'text', text: 'Duty saved' }
    }
    return { type: 'text', text: 'Unbound reminder handled normally' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize a recurring duty' }], source: { kind: 'user' } }))
  await until(() => record !== undefined)
  await h.author.whenIdle()
  await h.rt.moveSchedules(h.writer.id, fresh.id)
  const moved = (await h.ctx.schedule.list({ sessionId: fresh.id }))[0]
  assert.ok(moved)
  assert.notEqual(moved.id, record.id)
  assert.deepEqual(await h.ctx.schedule.list({ sessionId: h.writer.id }), [])
  assert.deepEqual((await h.ctx.dsBotAutonomy.responsibilities.list())[0].scheduleBindings, [moved.id])
  const foreign = await h.ctx.schedule.create(h.writer.id, { title: 'Unbound', prompt: 'Keep unbound prompt', every_seconds: 3600 })
  // Return this bound record to its current Bot using the same public move hook.
  await h.rt.moveSchedules(fresh.id, h.writer.id)
  const bound = (await h.ctx.schedule.list({ sessionId: h.writer.id })).find(candidate => candidate.title === 'Saved duty')
  const framing = renderRecurringReminderBatchFraming([{ record: bound, occurrenceAt: '2030-01-01T00:00:00.000Z' }, { record: foreign, occurrenceAt: '2030-01-01T00:00:00.000Z' }])
  for (let i = 0; i < 2; i++) {
    h.writer.followup(createUserMessage({ content: [{ type: 'text', text: framing }], source: { kind: 'schedule' } }))
    await h.writer.whenIdle()
    await settle()
  }
  const work = await h.ctx.dsBotAutonomy.list()
  assert.equal(work.filter(item => item.origin.kind === 'schedule').length, 1)
  const logged = h.writer.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule')
  assert.ok(logged.some(event => event.data.content[0].text.includes('Keep unbound prompt')))
  assert.ok(logged.every(event => !event.data.content[0].text.includes('Bound trigger')))
})

test('unloading active native work leaves a durable wait and remount does not start another round', async t => {
  const h = await nativeHarness(t)
  let item
  let entered = false
  let release
  let rearmed = false
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    const allText = options.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text)
    if (allText.includes('Authorize reload work')) {
      if (allText.includes('Resume after reload') && !rearmed) { rearmed = true; await h.ctx.dsBotAutonomy.resume(item.id, h.author) }
      else item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Survive reload', acceptance: 'Complete after explicit resume', maxGoalRounds: 3 }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    if (!entered) { entered = true; await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }) }); return { type: 'text', text: 'Interrupted output' } }
    const goal = h.ctx.goals.get(h.writer)
    if (goal.phase === 'complete') return { type: 'text', text: 'Explicitly resumed result' }
    return { type: 'tool-call', id: 'reload-complete', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize reload work' }], source: { kind: 'user' } }))
  await until(() => entered)
  await h.fiber.dispose()
  release()
  await h.writer.whenIdle()
  assert.equal(h.ctx.get('dsBotAutonomy'), undefined)
  const roundsBefore = h.ctx.goals.get(h.writer).roundsStarted
  const remount = h.ctx.plugin(Autonomy)
  await remount.await()
  await until(() => h.ctx.get('dsBotAutonomy') !== undefined)
  await settle()
  const saved = await h.ctx.dsBotAutonomy.get(item.id)
  assert.equal(saved.status, 'waiting')
  assert.equal(saved.waitReason, 'restart')
  assert.equal(h.ctx.goals.get(h.writer).activation, 'disarmed')
  assert.equal(h.ctx.goals.get(h.writer).roundsStarted, roundsBefore)
  assert.equal(h.deliveries.length, 0)
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume after reload' }], source: { kind: 'user' } }))
  await until(() => h.deliveries.length === 1)
  assert.equal((await h.ctx.dsBotAutonomy.get(item.id)).consumedRounds, 2)
})

test('native part transfer creates only the remaining budget and fences the old Session', async t => {
  const h = await nativeHarness(t)
  const fresh = await h.addBot('fresh')
  let item
  let entered = false
  let release
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.text === 'Authorize transfer work'))) {
      item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Transfer bounded work', acceptance: 'Final result in the current part', maxGoalRounds: 3, resources: ['computer:shared'] }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    if (!entered) { entered = true; await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }) }); return { type: 'text', text: 'Old part output' } }
    const goal = h.ctx.goals.get(fresh)
    if (goal.phase === 'complete') return { type: 'text', text: 'Current part final result' }
    return { type: 'tool-call', id: 'part-complete', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize transfer work' }], source: { kind: 'user' } }))
  await until(() => entered)
  const oldGoal = h.ctx.goals.get(h.writer)
  const token = await h.rt.autonomyBeginPartMove({ botId: 'writer', fromSessionId: h.writer.id })
  h.writer.cancel({ kind: 'hook', reason: 'isolated-part-move' })
  release()
  await h.writer.whenIdle()
  h.rt.chatOf = id => id === 'writer' ? fresh.id : id + '-session'
  h.rt.chatOwners.set(fresh.id, 'writer')
  await h.rt.autonomyFinishPartMove(token, { botId: 'writer', fromSessionId: h.writer.id, toSessionId: fresh.id })
  await until(() => h.deliveries.length === 1)
  const saved = await h.ctx.dsBotAutonomy.get(item.id)
  assert.equal(saved.status, 'complete')
  assert.equal(saved.consumedRounds, 2)
  assert.equal(saved.maxGoalRounds, 3)
  assert.equal(saved.target.sessionId, fresh.id)
  assert.ok(saved.resources.includes('computer:shared'))
  assert.equal(h.ctx.goals.get(fresh).maxGoalRounds, 2)
  assert.equal(h.ctx.goals.get(h.writer).id, oldGoal.id)
  assert.equal(h.ctx.goals.get(h.writer).activation, 'disarmed')
  assert.doesNotMatch(saved.result, /Old part output/)
})

test('native user Stop after Goal completion fences the pending final text and delivery', async t => {
  const h = await nativeHarness(t)
  let item
  let finalEntered = false
  let release
  h.ctx.llm.registerAdapter(['offline'], new OfflineModel(async options => {
    if (options.messages.some(message => message.content?.some(block => block.text === 'Authorize final Stop work'))) {
      item ??= await h.ctx.dsBotAutonomy.submit({ botId: 'writer', objective: 'Final Stop work', acceptance: 'Final text delivered once', maxGoalRounds: 2 }, h.author)
      return { type: 'text', text: 'Authorized' }
    }
    const goal = h.ctx.goals.get(h.writer)
    if (goal.phase === 'active') return { type: 'tool-call', id: 'before-stop-complete', name: 'update_goal', arguments: { action: 'complete', goal_id: goal.id, revision: goal.revision } }
    finalEntered = true
    await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }) })
    return { type: 'text', text: 'Cancelled final text' }
  }))
  h.author.followup(createUserMessage({ content: [{ type: 'text', text: 'Authorize final Stop work' }], source: { kind: 'user' } }))
  await until(() => finalEntered)
  assert.equal(h.ctx.goals.get(h.writer).phase, 'complete')
  h.writer.cancel({ kind: 'user' })
  release()
  await h.writer.whenIdle()
  await until(async () => (await h.ctx.dsBotAutonomy.get(item.id)).status === 'stopped')
  assert.equal(h.deliveries.length, 0)
})
