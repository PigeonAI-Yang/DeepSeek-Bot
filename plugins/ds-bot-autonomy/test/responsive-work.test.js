import test from 'node:test'
import assert from 'node:assert/strict'
import { responsiveToolDecision, installResponsiveWork, RESPONSIVE_WORK_PROMPT } from '../src/responsive-work.js'

test('long execution is launched only through native background commands and reads never wait', () => {
  assert.equal(responsiveToolDecision('pwsh', { command: 'python generate.py' }).kind, 'deny')
  assert.equal(responsiveToolDecision('bash', { command: 'sleep 90' }).kind, 'deny')
  assert.equal(responsiveToolDecision('pwsh', { run_in_background: true }), undefined)
  assert.equal(responsiveToolDecision('job_output', { wait: true }).kind, 'deny')
  assert.equal(responsiveToolDecision('job_output', { wait: false }), undefined)
  assert.equal(responsiveToolDecision('read_file', {}), undefined)
  assert.match(RESPONSIVE_WORK_PROMPT, /After each new human message/)
})

function fixture() {
  const listeners = new Map()
  const agent = { id: 'bot' }
  const goal = { id: 'goal', revision: 1, phase: 'active', activation: 'armed' }
  let generation = 0
  let available = true
  let onJob
  let resumed = 0
  let cancelled = 0
  const waits = new Map()
  const rows = [{ id: 'job', owner: 'bot', status: 'running' }]
  const jobs = { list: () => rows, events: { subscribe: (_filter, listener) => { onJob = listener; return () => { onJob = undefined } } }, kill: () => { cancelled++ } }
  const ctx = { get: () => jobs, on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name) } }
  const dispose = installResponsiveWork(ctx, {
    host: { owner: id => id === 'bot' ? {} : undefined }, agents: { get: () => agent },
    goals: { disarm: () => { goal.activation = 'disarmed' }, resume: () => { goal.activation = 'armed'; resumed++ } },
    systemPrompt: { getSectionOrder: () => 10, section: () => () => {} },
    managedGoal: () => available ? { goal, generation } : undefined, waits,
  })
  return { agent, goal, rows, waits, listeners, dispose, settled(cause = 'producer') { rows[0].status = 'completed'; onJob({ type: 'settled', job: rows[0], cause }) }, get resumed() { return resumed }, get cancelled() { return cancelled }, stop() { generation++; available = false } }
}

test('background work leaves the process running and releases automatic Goal rounds until completion', async () => {
  const h = fixture()
  h.listeners.get('tools/result')({ agent: h.agent, name: 'pwsh' }, { isError: false, value: { jobId: 'job' } })
  assert.equal(h.goal.activation, 'disarmed')
  assert.equal(h.rows[0].status, 'running')
  assert.equal(h.cancelled, 0)
  assert.equal(await h.listeners.get('tools/pre-execute')({ agent: h.agent, name: 'job_output', arguments: { wait: false } }, async () => ({ kind: 'allow' })).then(value => value.kind), 'allow')
  h.settled()
  assert.equal(h.resumed, 1)
  assert.equal(h.goal.activation, 'armed')
  h.dispose()
})

test('user Stop, foreign goals, kill and teardown never rearm work', () => {
  for (const cause of ['kill', 'teardown']) {
    const h = fixture()
    h.listeners.get('tools/result')({ agent: h.agent, name: 'pwsh' }, { isError: false, value: { jobId: 'job' } })
    h.settled(cause)
    assert.equal(h.resumed, 0)
    h.dispose()
  }
  const h = fixture()
  h.listeners.get('tools/result')({ agent: h.agent, name: 'pwsh' }, { isError: false, value: { jobId: 'job' } })
  h.stop(); h.settled()
  assert.equal(h.resumed, 0)
  h.dispose()
})

test('the policy never changes other sessions or caller arguments', async () => {
  const h = fixture()
  const args = Object.freeze({ command: 'original', timeoutMs: 90000 })
  const next = async () => ({ kind: 'allow' })
  assert.equal((await h.listeners.get('tools/pre-execute')({ agent: { id: 'foreign' }, name: 'pwsh', arguments: args }, next)).kind, 'allow')
  assert.equal(args.command, 'original')
  assert.equal(args.timeoutMs, 90000)
  h.dispose()
})

test('a waiting Goal cannot finish prematurely, and explicit Stop cancels only its captured job', async () => {
  const h = fixture()
  h.listeners.get('tools/result')({ agent: h.agent, name: 'pwsh' }, { isError: false, value: { jobId: 'job' } })
  h.rows.push({ id: 'unrelated', owner: 'bot', status: 'running' })
  const decision = await h.listeners.get('tools/pre-execute')({ agent: h.agent, name: 'update_goal', arguments: { action: 'complete' } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  h.stop()
  h.waits.get('bot').cancel()
  assert.equal(h.cancelled, 1)
  h.dispose()
})
