import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { openStore } from './store.js'
import { messageText, parseScheduleInput, renderRemainingScheduleInput, replaceMessageText } from './schedule-input.js'
import { installResponsiveWork } from './responsive-work.js'

const DEFAULT_ROUNDS = 20
const OWNER_ACTIVE = new Set(['activating', 'active', 'waiting'])
const nonEmpty = value => typeof value === 'string' && value.trim() !== ''
const allowedScopeOf = item => item.evidence?.split('\n').find(line => line.startsWith('Allowed scope: '))?.slice('Allowed scope: '.length) || 'the assigned task only'
const appendEvidence = (current, line) => [current, line].filter(Boolean).join('\n')
const workPrompt = item => [
  `DS Bot autonomous work item ${item.id}`,
  `Objective: ${item.objective}`,
  `Acceptance: ${item.acceptance}`,
  ...(item.origin.kind === 'schedule' && item.origin.triggerText ? [`Scheduled trigger: ${item.origin.triggerText}`] : []),
  `Allowed scope: ${allowedScopeOf(item)}`,
].join('\n')

const taskSystemPrompt = item => [
  '## Authorized autonomous work',
  `Goal: ${item.objective}`,
  `Acceptance: ${item.acceptance}`,
  `Allowed scope: ${allowedScopeOf(item)}`,
  'Work only within this saved objective and acceptance. Use evidence from the work and report only what it establishes.',
  'Ask the user only when a decision or input is needed. In your own chat, use ask_user; the task will wait for the matching answer. In a group, state the concrete blocker and use the native goal blocked action when the blocking condition is established.',
  'When the acceptance conditions are met, use the native goal completion action, then write the final result and verification. Do not mark complete while required work remains.',
  'If you delegate with autonomy_delegate_work, evaluate the returned evidence against this task’s acceptance and integrate it before completing the parent task.',
].join('\n')

function cloneTarget(target) {
  return { botId: target.botId, ...(target.roomId === undefined ? {} : { roomId: target.roomId }), sessionId: target.sessionId }
}

function goalMatches(view, ref) {
  return view !== undefined && ref !== undefined && view.id === ref.id && view.revision === ref.revision
}

function directHumanAuthorization(agents, agent, requireInitiator) {
  if (agent === undefined || agents.get(agent.id) !== agent || agent.status !== 'running') throw new Error('A live running Session is required')
  if (!agents.roots().includes(agent)) throw new Error('Only a top-level Agent can authorize autonomous work')
  if (requireInitiator && agents.currentInitiator() !== agent) throw new Error('A direct human turn is required')
  const events = agent.session.snapshotEvents()
  let open
  let human
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = event
      human = undefined
    } else if (event.type === 'turn/end' && open?.data?.turn === event.data?.turn) {
      open = undefined
      human = undefined
    } else if (open !== undefined && event.type === 'user/message' && event.data?.source?.kind === 'user') {
      human = event
    }
  }
  if (open === undefined || human === undefined) throw new Error('This operation requires a direct human message in the current Agent turn')
  return {
    sessionId: agent.session.id,
    turnStartSeq: open.seq,
    messageSeq: human.seq,
    ...(typeof human.data?.id === 'string' ? { messageId: human.data.id } : {}),
    authorizedAt: human.time,
  }
}

function readQuestionId(message) {
  if (message?.source?.kind !== 'user-question-reply') return undefined
  const value = messageText(message)
  try {
    const parsed = JSON.parse(value)
    if (parsed?.kind !== 'answer_to_pending_question' || parsed?.tool !== 'ask_user') return undefined
    return parsed.questions?.find(item => typeof item?.id === 'string')?.id
  } catch {
    return undefined
  }
}

export function createAutonomyService(ctx, services) {
  const { agents, goals, host, storageDomain, systemPrompt } = services
  let store
  let schedule
  let disposed = false
  let accepting = true
  let opening
  let pumping
  let activationChain = Promise.resolve()
  let stopping
  let attachedDisposer
  const bySession = new Map()
  const currentTurns = new Map()
  const backgroundWaits = new Map()
  const perItem = new Map()
  const extensionDisposers = []
  const heldScheduleItems = new Set()
  const stoppedWorkIds = new Set()

  const ensureReady = () => opening ??= (async () => {
    if (host.version !== 1) throw new Error('DS Bot autonomy requires host adapter version 1')
    await host.ready()
    store = await openStore(storageDomain)
    await recover()
    return store
  })()
  const ensureWritable = async () => {
    await ensureReady()
    if (!accepting || disposed) throw new Error('DS Bot autonomy is stopping')
    if (!host.writable()) throw new Error('DS Bot is read-only')
  }
  const serial = (id, action) => {
    const prior = perItem.get(id) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(action)
    perItem.set(id, next)
    return next.finally(() => { if (perItem.get(id) === next) perItem.delete(id) })
  }
  const putWork = async item => {
    await store.workItems.put(item.id, item)
    return item
  }
  const updateWork = async (id, change) => {
    const current = store.workItems.get(id)
    if (current === undefined) throw new Error('Work item not found')
    const next = { ...current, ...change, updatedAt: Date.now() }
    await store.workItems.put(id, next)
    return next
  }
  const getWork = async id => {
    await ensureReady()
    return store.workItems.get(String(id))
  }
  const listWork = async filter => {
    await ensureReady()
    const rows = [...store.workItems.entries()].map(([, item]) => item)
    return rows.filter(item => filter?.status === undefined || item.status === filter.status)
      .filter(item => filter?.targetId === undefined || item.target.botId === filter.targetId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  const listResponsibilities = async filter => {
    await ensureReady()
    const rows = [...store.responsibilities.entries()].map(([, item]) => item)
    return rows.filter(item => filter?.targetId === undefined || item.target.botId === filter.targetId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  const requireAuthorization = (agent, requireInitiator = true) => directHumanAuthorization(agents, agent, requireInitiator)
  const toolAuthorization = exec => requireAuthorization(exec?.agent)
  const apiAuthorization = body => {
    const sessionId = String(body?.sessionId ?? '')
    const agent = agents.get(sessionId)
    return { agent, authorizationRef: requireAuthorization(agent, false) }
  }
  const returnAddress = sessionId => {
    const owner = host.owner(sessionId)
    if (owner === undefined) throw new Error('The authorizing Session is not a current DS Bot chat')
    return { ...owner, sessionId, audience: 'user' }
  }

  function resourceKeys(target, resources = []) {
    if (!Array.isArray(resources) || resources.some(resource => !nonEmpty(resource))) throw new Error('Resources must be nonempty path or shared resource strings')
    const normalize = resource => resource.startsWith('path:') ? `path:${resolvePath(resource.slice(5)).toLowerCase()}` : resource
    return [...new Set([`bot:${target.botId}`, `session:${target.sessionId}`, ...resources.filter(resource => !resource.startsWith('bot:') && !resource.startsWith('session:')).map(normalize)])]
  }

  function makeWorkItem({ target, objective, acceptance, allowedScope = '', authorizationRef, origin, returnTo, responsibilityId, parentWorkItemId, dependencyWorkItemId, dependencyExchangeId, dependencySessionId, maxGoalRounds = DEFAULT_ROUNDS, resources = [], triggerKey, nativeMessageId }) {
    if (!nonEmpty(objective) || !nonEmpty(acceptance)) throw new Error('Objective and acceptance are required')
    if (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1) throw new Error('maxGoalRounds must be a positive safe integer')
    const now = Date.now()
    return {
      id: randomUUID(),
      ...(responsibilityId ? { responsibilityId } : {}),
      ...(parentWorkItemId ? { parentWorkItemId } : {}),
      objective: objective.trim(),
      acceptance: acceptance.trim(),
      target: cloneTarget(target),
      origin,
      ...(returnTo ? { returnAddress: returnTo } : {}),
      ...(triggerKey ? { triggerKey } : {}),
      ...(nativeMessageId ? { nativeMessageId } : {}),
      ...(dependencyWorkItemId ? { dependencyWorkItemId } : {}),
      ...(dependencyExchangeId ? { dependencyExchangeId } : {}),
      ...(dependencySessionId ? { dependencySessionId } : {}),
      authorizationRef,
      status: 'queued',
      maxGoalRounds,
      consumedRounds: 0,
      stopGeneration: 0,
      resources: resourceKeys(target, resources),
      delivery: { id: randomUUID(), state: 'intent' },
      createdAt: now,
      updatedAt: now,
      ...(allowedScope ? { evidence: `Allowed scope: ${allowedScope.trim()}` } : {}),
    }
  }

  function hasResourceConflict(item) {
    const active = [...store.workItems.entries()].map(([, work]) => work).filter(work => OWNER_ACTIVE.has(work.status) && work.id !== item.id)
    const overlaps = (left, right) => left === right || (left.startsWith('path:') && right.startsWith('path:')
      && (left.startsWith(right.endsWith('\\') ? right : right + '\\') || right.startsWith(left.endsWith('\\') ? left : left + '\\') || left.startsWith(right + '/') || right.startsWith(left + '/')))
    return active.some(work => work.resources.some(resource => item.resources.some(own => overlaps(own, resource))))
  }

  function runtimeFor(item, agent) {
    let runtime = bySession.get(item.target.sessionId)
    if (runtime === undefined || runtime.workItemId !== item.id) {
      runtime = {
        workItemId: item.id, agent, sessionId: item.target.sessionId, generation: item.stopGeneration,
        ready: false, pendingRoundWrite: Promise.resolve(), pendingWrites: Promise.resolve(),
        roundsStarted: 0, goalRoundBase: item.consumedRounds, terminal: undefined,
      }
      bySession.set(item.target.sessionId, runtime)
    }
    runtime.agent = agent
    return runtime
  }

  function fenceWorkItem(id, item) {
    stoppedWorkIds.add(id)
    const background = backgroundWaits.get(item.target.sessionId)
    if (background && background.id === item.goalRef?.id && background.generation === item.stopGeneration) {
      backgroundWaits.delete(item.target.sessionId)
      background.cancel()
    }
    const runtime = bySession.get(item.target.sessionId)
    if (runtime?.workItemId === id) {
      runtime.ready = false
      runtime.ownedGoalId = undefined
      goals.disarm(runtime.agent)
    }
  }

  function activate(id, options) {
    const pending = activationChain.then(() => activateOwned(id, options))
    activationChain = pending.catch(() => {})
    return pending
  }

  async function activateOwned(id, { resume = false, transferWaitReason } = {}) {
    await ensureReady()
    if (!accepting || !host.writable() || heldScheduleItems.has(id) || stoppedWorkIds.has(id)) return
    let item = store.workItems.get(id)
    if (item === undefined || (item.status !== 'queued' && !(resume && item.status === 'waiting' && item.waitReason !== 'question-answer')
      && !(transferWaitReason !== undefined && item.status === 'waiting' && item.waitReason === 'part-move'))) return
    if (hasResourceConflict(item)) return
    let target
    try {
      target = host.target(item.target.botId, item.target.roomId)
    } catch {
      return
    }
    if (resume && target.sessionId !== item.target.sessionId) {
      const fromSessionId = item.target.sessionId
      const oldGoalRef = item.goalRef
      item = await serial(id, () => updateWork(id, {
        target: cloneTarget(target),
        resources: resourceKeys(target, item.resources),
        goalRef: undefined,
        ...(oldGoalRef ? { partMove: { fromSessionId, toSessionId: target.sessionId, goalRef: oldGoalRef, remainingRounds: item.maxGoalRounds - item.consumedRounds } } : {}),
      }))
    }
    let agent
    try {
      agent = await host.resolve(target)
    } catch {
      return
    }
    if (stoppedWorkIds.has(id)) return
    if (agent.status !== 'idle') return
    const currentGoal = goals.get(agent)
    if (!resume && currentGoal !== undefined && currentGoal.phase !== 'complete') return
    if (resume && currentGoal !== undefined && item.goalRef !== undefined && currentGoal.id !== item.goalRef.id) return
    if (resume && currentGoal === undefined && item.goalRef !== undefined) return

    const generation = item.stopGeneration
    item = await serial(id, async () => {
      const latest = store.workItems.get(id)
      if (stoppedWorkIds.has(id) || latest === undefined || latest.stopGeneration !== generation || latest.status === 'stopped') return latest
      return updateWork(id, { status: 'activating', waitReason: transferWaitReason, target: cloneTarget(target) })
    })
    if (item === undefined || item.status !== 'activating' || stoppedWorkIds.has(id)) return
    const runtime = runtimeFor(item, agent)
    runtime.generation = generation
    runtime.ready = false
    runtime.terminal = undefined
    let goal
    let releaseBinding
    runtime.binding = new Promise(resolve => { releaseBinding = resolve })
    runtime.ownedGoalId = undefined
    try {
      if (resume && currentGoal !== undefined && item.goalRef !== undefined && currentGoal.phase !== 'complete') {
        goal = goals.resume(agent, { id: currentGoal.id, revision: currentGoal.revision })
      } else {
        const remaining = item.maxGoalRounds - item.consumedRounds
        if (remaining < 1) {
          const blocked = await updateWork(id, { status: 'blocked', waitReason: 'round-budget-exhausted', result: `The total round budget of ${item.maxGoalRounds} was exhausted before the acceptance conditions were met.` })
          await deliverFinal(blocked)
          return
        }
        goal = goals.create(agent, { objective: workPrompt(item), maxGoalRounds: remaining })
      }
      runtime.ownedGoalId = goal.id
      if (transferWaitReason === 'question' || transferWaitReason === 'dependency') {
        goal = goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: transferWaitReason === 'question' ? 'needs-user-input' : 'waiting-for-dependency',
          message: transferWaitReason === 'question' ? 'Waiting for the matching user answer.' : 'Waiting for the delegated work result.',
        })
      } else if (transferWaitReason !== undefined) {
        goals.disarm(agent)
      }
      const remainActive = transferWaitReason === undefined
      const bound = await serial(id, async () => {
        const latest = store.workItems.get(id)
        if (stoppedWorkIds.has(id) || latest === undefined || latest.stopGeneration !== generation || latest.status === 'stopped' || !host.writable()) {
          goals.disarm(agent)
          return undefined
        }
        return updateWork(id, {
          status: remainActive ? 'active' : 'waiting',
          target: cloneTarget(target),
          goalRef: { id: goal.id, revision: goal.revision },
          waitReason: remainActive ? undefined : transferWaitReason,
        })
      })
      if (bound === undefined || stoppedWorkIds.has(id)) {
        runtime.ready = false
        runtime.ownedGoalId = undefined
        goals.disarm(agent)
        return
      }
      runtime.goalRef = { id: goal.id, revision: goal.revision }
      runtime.roundsStarted = goal.roundsStarted
      runtime.goalRoundBase = item.consumedRounds - goal.roundsStarted
      if (runtime.goalRoundBase < 0) {
        runtime.ready = false
        goals.disarm(agent)
        await serial(id, () => updateWork(id, { status: 'waiting', waitReason: 'round-accounting-mismatch', evidence: appendEvidence(item.evidence, 'The native Goal round count exceeds the saved total round count.') }))
        return
      }
      runtime.ready = remainActive

    } catch (error) {
      runtime.ready = false
      runtime.ownedGoalId = undefined
      goals.disarm(agent)
      await serial(id, async () => {
        const latest = store.workItems.get(id)
        if (!stoppedWorkIds.has(id) && latest?.stopGeneration === generation && latest.status !== 'stopped') {
          await updateWork(id, { status: 'waiting', waitReason: 'activation-failed', evidence: appendEvidence(latest.evidence, `Activation failed: ${String(error?.message ?? error)}`) })
        }
      })
    } finally {
      releaseBinding()
    }
  }

  async function pump() {
    if (pumping || !accepting || disposed) return
    pumping = true
    try {
      await ensureReady()
      if (!host.writable()) return
      for (const [id, item] of store.workItems.entries()) {
        if (item.status === 'queued' && !stoppedWorkIds.has(id)) await activate(id)
      }
    } finally {
      pumping = false
    }
  }

  async function recover() {
    for (const [id, saved] of store.workItems.entries()) {
      let item = saved
      if (['complete', 'blocked'].includes(item.status) && item.delivery.state === 'intent') {
        await deliverFinal(item)
        continue
      }
      if (!['queued', 'activating', 'active', 'waiting', 'stopped'].includes(item.status)) continue
      let agent
      let goal
      try {
        const target = host.target(item.target.botId, item.target.roomId)
        agent = await host.resolve(target)
        goal = goals.get(agent)
      } catch { /* The durable task remains waiting until its target is available. */ }
      if (item.status === 'active' && goal?.phase === 'complete' && item.goalRef?.id === goal.id) {
        const result = completedTurnText(agent, goal.id)
        item = await store.workItems.update(id, current => ({
          ...current,
          status: 'complete',
          goalRef: { id: goal.id, revision: goal.revision },
          ...(result ? { result } : {}),
          updatedAt: Date.now(),
        }))
        if (item.delivery.state === 'intent') await deliverFinal(item)
        continue
      }
      const orphan = item.status === 'activating' && item.goalRef === undefined && goal?.objective?.startsWith(`DS Bot autonomous work item ${item.id}\n`)
        ? { id: goal.id, revision: goal.revision } : undefined
      if (['queued', 'activating', 'active'].includes(item.status)) {
        item = await store.workItems.update(id, current => ({
          ...current,
          status: 'waiting',
          waitReason: 'restart',
          stopGeneration: current.stopGeneration + 1,
          ...(orphan ? { goalRef: orphan } : {}),
          updatedAt: Date.now(),
        }))
      }
      if (agent !== undefined && goal !== undefined && (item.goalRef?.id === goal.id || orphan?.id === goal.id)) {
        try { goals.disarm(agent) } catch { /* The durable wait record still prevents a new Goal from being admitted. */ }
      }
    }
  }

  function completedTurnText(agent, goalId) {
    const events = agent.session.snapshotEvents()
    const completion = events.findLastIndex(event => event.type === 'goal/change' && event.data?.operation === 'complete' && event.data?.goal?.id === goalId)
    if (completion < 0) return ''
    let start = -1
    let turn
    for (let index = completion; index >= 0; index--) {
      if (events[index].type === 'turn/start') { start = index; turn = events[index].data?.turn; break }
      if (events[index].type === 'turn/end') return ''
    }
    if (start < 0) return ''
    const texts = []
    for (let index = start + 1; index < events.length; index++) {
      const event = events[index]
      if (event.type === 'assistant/message') {
        const text = messageText(event.data?.message)
        if (text) texts.push(text)
      }
      if (event.type === 'turn/end' && event.data?.turn === turn) return texts.join('\n\n').trim()
    }
    return ''
  }

  async function submit(input, actor, { api = false } = {}) {
    await ensureWritable()
    const authorizationRef = api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor)
    const origin = { kind: 'human', ...(authorizationRef.messageId ? { messageId: authorizationRef.messageId } : {}) }
    const target = host.target(String(input.botId ?? input.bot_id ?? ''), input.roomId ?? input.room_id)
    const address = returnAddress(authorizationRef.sessionId)
    const item = makeWorkItem({
      target,
      objective: input.objective,
      acceptance: input.acceptance,
      allowedScope: input.allowedScope ?? input.allowed_scope ?? '',
      authorizationRef,
      origin,
      returnTo: address,
      maxGoalRounds: input.maxGoalRounds ?? input.max_goal_rounds ?? DEFAULT_ROUNDS,
      nativeMessageId: authorizationRef.messageId,
      resources: input.resources ?? [],
    })
    await putWork(item)
    void pump().catch(() => {})
    return item
  }

  async function stop(id, actor, { api = false } = {}) {
    await ensureWritable()
    const authorizationRef = api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor)
    const item = store.workItems.get(id)
    if (item === undefined) throw new Error('Work item not found')
    fenceWorkItem(id, item)
    const stopped = await serial(id, async () => {
      const item = store.workItems.get(id)
      if (item === undefined) throw new Error('Work item not found')
      const next = await updateWork(id, { status: 'stopped', waitReason: 'user-stop', stopGeneration: item.stopGeneration + 1, authorizationRef })
      const runtime = bySession.get(item.target.sessionId)
      if (runtime?.workItemId === id) {
        runtime.ready = false
        runtime.generation = next.stopGeneration
        goals.disarm(runtime.agent)
        if (runtime.agent.status === 'running') runtime.agent.cancel({ kind: 'hook', reason: 'ds-bot-autonomy/stopped' })
        else bySession.delete(item.target.sessionId)
      } else {
        try {
          const target = host.target(item.target.botId, item.target.roomId)
          const agent = await host.resolve(target)
          const goal = goals.get(agent)
          if (goal !== undefined && goal.id === item.goalRef?.id) goals.disarm(agent)
        } catch {
          // The durable stop still fences late work when the Session is unavailable.
        }
      }
      return next
    })
    return stopped
  }

  async function resume(id, actor, { api = false } = {}) {
    await ensureWritable()
    const authorizationRef = api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor)
    const item = await serial(id, async () => {
      const current = store.workItems.get(id)
      if (current === undefined) throw new Error('Work item not found')
      if (current.status === 'active') {
        const target = host.target(current.target.botId, current.target.roomId)
        const agent = await host.resolve(target)
        const goal = goals.get(agent)
        if (goal?.activation !== 'disarmed' || !goalMatches(goal, current.goalRef)) throw new Error('Active work is already running')
      } else if (!['stopped', 'waiting', 'blocked'].includes(current.status)) {
        throw new Error('Only stopped or waiting work can be resumed')
      }
      return updateWork(id, { status: 'queued', waitReason: undefined, stopGeneration: current.stopGeneration + (current.status === 'stopped' ? 1 : 0), authorizationRef })
    })
    stoppedWorkIds.delete(id)
    if (item.goalRef !== undefined) await activate(id, { resume: true })
    else void pump().catch(() => {})
    return store.workItems.get(id)
  }

  async function createResponsibility(input, actor, { api = false, authorizationRef } = {}) {
    await ensureWritable()
    const authorizedBy = authorizationRef ?? (api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor))
    const target = host.target(String(input.botId ?? input.bot_id ?? ''), input.roomId ?? input.room_id)
    const now = Date.now()
    const responsibility = {
      id: randomUUID(),
      target: cloneTarget(target),
      objective: String(input.objective ?? '').trim(),
      acceptance: String(input.acceptance ?? '').trim(),
      authorizationRef: authorizedBy,
      allowedScope: String(input.allowedScope ?? input.allowed_scope ?? '').trim(),
      resources: resourceKeys(target, input.resources ?? []).filter(resource => !resource.startsWith('bot:') && !resource.startsWith('session:')),
      stopped: false,
      scheduleBindings: [],
      createdAt: now,
      updatedAt: now,
    }
    if (!nonEmpty(responsibility.objective) || !nonEmpty(responsibility.acceptance) || !nonEmpty(responsibility.allowedScope)) {
      throw new Error('Objective, acceptance, and allowed scope are required')
    }
    await store.responsibilities.put(responsibility.id, responsibility)
    if (input.schedule !== undefined) await createSchedule(responsibility.id, input.schedule, actor, { api, authorizationRef })
    return store.responsibilities.get(responsibility.id)
  }

  async function updateResponsibility(id, patch, actor, { api = false, authorizationRef } = {}) {
    await ensureWritable()
    const authorizedBy = authorizationRef ?? (api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor))
    const current = store.responsibilities.get(id)
    if (current === undefined) throw new Error('Responsibility not found')
    const next = {
      ...current,
      ...(patch.objective !== undefined ? { objective: String(patch.objective).trim() } : {}),
      ...(patch.acceptance !== undefined ? { acceptance: String(patch.acceptance).trim() } : {}),
      ...(patch.allowedScope !== undefined || patch.allowed_scope !== undefined ? { allowedScope: String(patch.allowedScope ?? patch.allowed_scope).trim() } : {}),
      ...(patch.stopped !== undefined ? { stopped: patch.stopped === true } : {}),
      ...(patch.resources !== undefined ? { resources: resourceKeys(current.target, patch.resources).filter(resource => !resource.startsWith('bot:') && !resource.startsWith('session:')) } : {}),
      authorizationRef: authorizedBy,
      updatedAt: Date.now(),
    }
    if (!nonEmpty(next.objective) || !nonEmpty(next.acceptance) || !nonEmpty(next.allowedScope)) throw new Error('Objective, acceptance, and allowed scope are required')
    await store.responsibilities.put(id, next)
    return next
  }

  async function deleteResponsibility(id, actor, options = {}) {
    return updateResponsibility(id, { stopped: true }, actor, options)
  }

  async function createSchedule(responsibilityId, request, actor, { api = false, authorizationRef } = {}) {
    await ensureWritable()
    const auth = authorizationRef ?? (api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor))
    if (schedule === undefined) throw new Error('DSH Schedule is not available')
    const current = store.responsibilities.get(responsibilityId)
    if (current === undefined || current.stopped) throw new Error('Responsibility is unavailable')
    const target = host.target(current.target.botId, current.target.roomId)
    const created = await schedule.create(target.sessionId, request)
    const next = { ...current, authorizationRef: auth, target: cloneTarget(target), scheduleBindings: [...new Set([...current.scheduleBindings, created.id])], updatedAt: Date.now() }
    try {
      await store.responsibilities.put(current.id, next)
    } catch (error) {
      await schedule.delete({ sessionId: target.sessionId, id: created.id })
      throw error
    }
    return created
  }

  async function listSchedules(responsibilityId, actor, { api = false, authorizationRef } = {}) {
    await ensureReady()
    const current = store.responsibilities.get(responsibilityId)
    if (current === undefined) throw new Error('Responsibility not found')
    if (schedule === undefined) return { available: false, tasks: [] }
    if (authorizationRef === undefined && actor !== undefined) {
      if (api) apiAuthorization(actor)
      else requireAuthorization(actor)
    }
    const target = host.target(current.target.botId, current.target.roomId)
    const tasks = await schedule.list({ sessionId: target.sessionId })
    const ids = new Set(current.scheduleBindings)
    return { available: true, tasks: tasks.filter(task => ids.has(task.id)) }
  }

  async function updateSchedule(id, patch, actor, { api = false, authorizationRef } = {}) {
    await ensureWritable()
    const authorizedBy = authorizationRef ?? (api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor))
    if (schedule === undefined) throw new Error('DSH Schedule is not available')
    const responsibility = [...store.responsibilities.entries()].map(([, item]) => item).find(item => item.scheduleBindings.includes(id) && !item.stopped)
    if (responsibility === undefined) throw new Error('No active responsibility owns this schedule')
    const target = host.target(responsibility.target.botId, responsibility.target.roomId)
    const records = await schedule.list({ sessionId: target.sessionId })
    const expected = records.find(record => record.id === id)
    if (expected === undefined) throw new Error('Schedule not found on the current Session')
    const fields = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => !['sessionId', 'id', 'expected'].includes(key)))
    const updated = await schedule.update({ sessionId: target.sessionId, id, expected, ...fields })
    if (updated?.code) throw new Error(updated.message ?? updated.code)
    await store.responsibilities.put(responsibility.id, { ...responsibility, authorizationRef: authorizedBy, target: cloneTarget(target), updatedAt: Date.now() })
    return updated
  }

  async function deleteSchedule(id, actor, { api = false, authorizationRef } = {}) {
    await ensureWritable()
    const authorizedBy = authorizationRef ?? (api ? apiAuthorization(actor).authorizationRef : requireAuthorization(actor))
    if (schedule === undefined) throw new Error('DSH Schedule is not available')
    const responsibility = [...store.responsibilities.entries()].map(([, item]) => item).find(item => item.scheduleBindings.includes(id))
    if (responsibility === undefined) throw new Error('No responsibility owns this schedule')
    const target = host.target(responsibility.target.botId, responsibility.target.roomId)
    const result = await schedule.delete({ sessionId: target.sessionId, id })
    if (result?.deleted !== false) {
      await store.responsibilities.put(responsibility.id, {
        ...responsibility,
        authorizationRef: authorizedBy,
        scheduleBindings: responsibility.scheduleBindings.filter(binding => binding !== id),
        updatedAt: Date.now(),
      })
    }
    return result
  }

  function responsibilityForSchedule(scheduleId, owner) {
    return [...store.responsibilities.entries()].map(([, item]) => item).find(item => !item.stopped
      && item.scheduleBindings.includes(scheduleId)
      && item.target.botId === owner.botId
      && item.target.roomId === owner.roomId)
  }

  async function consumeScheduleMessages(agent, messages) {
    const owner = host.owner(agent.id)
    if (owner === undefined) return { messages, consumed: false, retained: true }
    let consumed = false
    let retained = false
    const output = []
    for (const message of messages) {
      if (message?.source?.kind !== 'schedule') {
        output.push(message)
        if (message?.role === 'user' && ['user', 'bot', 'user-question-reply', 'session-reference'].includes(message?.source?.kind)) retained = true
        continue
      }
      const rawText = messageText(message)
      const parsed = parseScheduleInput(rawText)
      if (!parsed.recognized) {
        output.push(message)
        retained = true
        continue
      }
      const remaining = []
      let messageConsumed = false
      for (const entry of parsed.entries) {
        if (!entry.scheduleId || !entry.occurrenceAt || !entry.prompt) {
          remaining.push(entry)
          continue
        }
        const responsibility = responsibilityForSchedule(entry.scheduleId, owner)
        if (responsibility === undefined) {
          remaining.push(entry)
          continue
        }
        const duplicate = [...store.workItems.entries()].map(([, item]) => item).find(item => item.origin.kind === 'schedule'
          && item.origin.scheduleId === entry.scheduleId && item.origin.occurrenceAt === entry.occurrenceAt)
        if (duplicate === undefined) {
          const target = host.target(owner.botId, owner.roomId)
          const item = makeWorkItem({
            target,
            objective: responsibility.objective,
            acceptance: responsibility.acceptance,
            allowedScope: responsibility.allowedScope,
            authorizationRef: responsibility.authorizationRef,
            responsibilityId: responsibility.id,
            resources: responsibility.resources ?? [],
            origin: { kind: 'schedule', scheduleId: entry.scheduleId, occurrenceAt: entry.occurrenceAt, triggerText: entry.prompt },
            returnTo: { ...owner, sessionId: target.sessionId, audience: 'user' },
            triggerKey: `${entry.scheduleId}:${entry.occurrenceAt}`,
            nativeMessageId: typeof message.id === 'string' ? message.id : undefined,
          })
          try {
            await putWork(item)
          } catch {
            const unowned = parsed.entries.filter(candidate => !candidate.scheduleId || !responsibilityForSchedule(candidate.scheduleId, owner))
            const retainedMessage = unowned.length > 0 ? replaceMessageText(message, renderRemainingScheduleInput(rawText, parsed.kind, unowned)) : undefined
            return { messages: [...output, ...(retainedMessage ? [retainedMessage] : []), ...messages.slice(messages.indexOf(message) + 1)], consumed: true, persistenceFailed: true }
          }
        }
        consumed = true
        messageConsumed = true
      }
      if (!messageConsumed || remaining.length > 0) {
        retained = true
        if (parsed.kind === 'single') output.push(message)
        else {
          const rendered = renderRemainingScheduleInput(rawText, parsed.kind, remaining)
          const replaced = replaceMessageText(message, rendered)
          if (replaced !== undefined) output.push(replaced)
        }
      }
    }
    return { messages: output, consumed, retained }
  }

  async function dispatchScheduleDecision(payload, decision) {
    if (decision.kind !== 'enter') return decision
    const sources = decision.messages.filter(message => message?.source?.kind === 'schedule')
    if (sources.length === 0) return decision
    const { messages, consumed, retained, persistenceFailed } = await consumeScheduleMessages(payload.agent, decision.messages)
    if (persistenceFailed) return messages.length === 0 ? { kind: 'reject' } : { ...decision, messages }
    if (consumed) void pump().catch(() => {})
    if (consumed && !retained) return { kind: 'reject' }
    return { ...decision, messages }
  }

  async function beginPartMove({ botId, roomId, fromSessionId }) {
    await ensureReady()
    const runtime = bySession.get(fromSessionId)
    if (runtime === undefined) return undefined
    const item = store.workItems.get(runtime.workItemId)
    if (item === undefined || !OWNER_ACTIVE.has(item.status) || item.stopGeneration !== runtime.generation
      || item.target.botId !== botId || item.target.roomId !== roomId) return undefined
    const goal = goals.get(runtime.agent)
    if (goal === undefined || !goalMatches(goal, item.goalRef)) return undefined
    const token = {
      workItemId: item.id,
      generation: item.stopGeneration,
      fromSessionId,
      previousWaitReason: item.waitReason,
      goalRef: { id: goal.id, revision: goal.revision },
    }
    await serial(item.id, async () => {
      const current = store.workItems.get(item.id)
      if (current === undefined || current.stopGeneration !== token.generation || !OWNER_ACTIVE.has(current.status)) throw new Error('Autonomy task changed before the part move')
      await updateWork(item.id, { status: 'waiting', waitReason: 'part-move' })
    })
    runtime.ready = false
    goals.disarm(runtime.agent)
    return token
  }

  async function finishPartMove(token, { botId, roomId, fromSessionId, toSessionId }) {
    if (token === undefined || token.fromSessionId !== fromSessionId) return
    if (stoppedWorkIds.has(token.workItemId)) return
    const current = store.workItems.get(token.workItemId)
    if (current === undefined || current.stopGeneration !== token.generation || current.status !== 'waiting' || current.waitReason !== 'part-move') return
    const target = host.target(botId, roomId)
    if (target.sessionId !== toSessionId) throw new Error('The DS Bot part does not match the completed move')
    const remainingRounds = current.maxGoalRounds - current.consumedRounds
    if (remainingRounds < 0) throw new Error('The saved task has exceeded its total round budget')
    const queued = await serial(current.id, async () => {
      const latest = store.workItems.get(current.id)
      if (stoppedWorkIds.has(current.id) || latest?.stopGeneration !== token.generation || latest.status !== 'waiting' || latest.waitReason !== 'part-move') return undefined
      return updateWork(current.id, {
        status: 'queued',
        target: cloneTarget(target),
        resources: resourceKeys(target, current.resources),
        goalRef: undefined,
        waitReason: 'part-move',
        partMove: { fromSessionId, toSessionId, goalRef: token.goalRef, remainingRounds },
      })
    })
    if (queued === undefined || stoppedWorkIds.has(current.id)) return
    if (bySession.get(fromSessionId)?.workItemId === current.id) bySession.delete(fromSessionId)
    for (const [id, responsibility] of store.responsibilities.entries()) {
      if (responsibility.target.botId !== botId || responsibility.target.roomId !== roomId || responsibility.target.sessionId !== fromSessionId) continue
      await store.responsibilities.put(id, { ...responsibility, target: cloneTarget(target), updatedAt: Date.now() })
    }
    if (remainingRounds === 0) {
      const exhausted = await serial(current.id, () => updateWork(current.id, {
        status: 'blocked',
        waitReason: 'round-budget-exhausted',
        result: `The total round budget of ${current.maxGoalRounds} was exhausted before the acceptance conditions were met.`,
      }))
      await deliverFinal(exhausted)
      return
    }
    const transferWaitReason = ['question', 'dependency', 'native-goal-paused'].includes(token.previousWaitReason)
      ? token.previousWaitReason : undefined
    await activate(current.id, { transferWaitReason })
  }

  async function abortPartMove(token, { botId, roomId, fromSessionId }) {
    if (token === undefined || token.fromSessionId !== fromSessionId) return
    const current = store.workItems.get(token.workItemId)
    const runtime = bySession.get(fromSessionId)
    if (current === undefined || runtime === undefined || current.stopGeneration !== token.generation || current.status !== 'waiting' || current.waitReason !== 'part-move') return
    let target
    try { target = host.target(botId, roomId) } catch { return }
    if (target.sessionId !== fromSessionId) return
    if (['question', 'dependency', 'native-goal-paused'].includes(token.previousWaitReason)) {
      await serial(current.id, () => updateWork(current.id, { waitReason: token.previousWaitReason }))
      return
    }
    await resumeBoundGoal(current, runtime, 'part-move-aborted')
  }

  async function scheduleMoved({ oldId, newId }) {
    if (typeof oldId !== 'string' || typeof newId !== 'string') return
    await ensureReady()
    for (const [id, responsibility] of store.responsibilities.entries()) {
      if (!responsibility.scheduleBindings.includes(oldId)) continue
      await store.responsibilities.put(id, {
        ...responsibility,
        scheduleBindings: [...new Set(responsibility.scheduleBindings.map(binding => binding === oldId ? newId : binding))],
        updatedAt: Date.now(),
      })
    }
  }

  function ownsRecovery(sessionId) {
    if (bySession.has(sessionId)) return true
    if (store === undefined) return false
    return [...store.workItems.entries()].some(([, item]) => item.target.sessionId === sessionId && OWNER_ACTIVE.has(item.status))
  }

  function ownsGoal(sessionId, goalId) {
    if (!accepting || disposed || !host.writable() || store === undefined) return false
    const runtime = bySession.get(sessionId)
    const item = runtime && store.workItems.get(runtime.workItemId)
    if (!item || !['activating', 'active', 'waiting'].includes(item.status) || stoppedWorkIds.has(item.id)
      || item.stopGeneration !== runtime.generation || item.target.sessionId !== sessionId
      || agents.get(sessionId) !== runtime.agent || runtime.agent.session?.id !== sessionId
      || runtime.ownedGoalId !== goalId) return false
    try {
      const goal = goals.get(runtime.agent)
      return host.target(item.target.botId, item.target.roomId).sessionId === sessionId
        && goal?.id === goalId && goal.phase !== 'complete'
    } catch { return false }
  }

  async function deliverFinal(item) {
    return serial(item.id, async () => {
      const current = store.workItems.get(item.id)
      if (stoppedWorkIds.has(item.id) || current === undefined || current.stopGeneration !== item.stopGeneration || current.status === 'stopped'
        || !['complete', 'blocked'].includes(current.status) || !current.returnAddress || current.delivery.state !== 'intent') return current
      const target = host.target(current.returnAddress.botId, current.returnAddress.roomId)
      const reply = current.parentWorkItemId !== undefined
      const text = [
        current.status === 'complete' ? `Autonomous work ${current.id} is complete.` : `Autonomous work ${current.id} is blocked.`,
        `Objective: ${current.objective}`,
        `Acceptance: ${current.acceptance}`,
        current.result ? `Result:\n${current.result}` : 'No final assistant text was recorded before the goal ended.',
        current.evidence ? `Evidence:\n${current.evidence}` : '',
      ].filter(Boolean).join('\n\n')
      try {
        const outcome = await host.deliver({
          id: current.delivery.id,
          target,
          fromId: current.target.botId,
          role: reply ? 'reply' : 'request',
          text,
          ...(reply && current.dependencyExchangeId ? { replyTo: current.dependencyExchangeId } : {}),
          ...(reply ? {} : { audience: current.returnAddress.audience === 'user' ? 'user' : undefined }),
        })
        if (outcome.state === 'receipt') return updateWork(current.id, { delivery: { id: current.delivery.id, state: 'receipt', receipt: outcome.receipt } })
        return updateWork(current.id, { status: 'delivery-ambiguous', delivery: { id: current.delivery.id, state: 'ambiguous' } })
      } catch (error) {
        return updateWork(current.id, {
          status: 'delivery-ambiguous',
          delivery: { id: current.delivery.id, state: 'ambiguous' },
          evidence: appendEvidence(current.evidence, `Final delivery ${current.delivery.id} needs reconciliation: ${String(error?.message ?? error)}`),
        })
      }
    })
  }

  async function resumeBoundGoal(item, runtime, waitReason) {
    return serial(item.id, async () => {
      const current = store.workItems.get(item.id)
      if (stoppedWorkIds.has(item.id) || current === undefined || current.stopGeneration !== runtime.generation || current.status === 'stopped'
        || !['waiting', 'activating'].includes(current.status)) return
      const target = host.target(current.target.botId, current.target.roomId)
      const agent = await host.resolve(target)
      if (stoppedWorkIds.has(item.id) || agent !== runtime.agent || agent.id !== current.target.sessionId) return
      const goal = goals.get(agent)
      if (goal === undefined || current.goalRef?.id !== goal.id || goal.phase === 'complete') return
      runtime.ready = false
      const activating = current.status === 'activating' ? current : await updateWork(item.id, {
        status: 'activating',
        target: cloneTarget(target),
        waitReason: waitReason ?? undefined,
      })
      if (stoppedWorkIds.has(item.id) || activating.stopGeneration !== runtime.generation || !host.writable()) return
      let resumed
      try {
        resumed = goals.resume(agent, { id: goal.id, revision: goal.revision })
        runtime.ownedGoalId = resumed.id
        await updateWork(item.id, { goalRef: { id: resumed.id, revision: resumed.revision } })
      } catch (error) {
        runtime.ownedGoalId = undefined
        goals.disarm(agent)
        if (!stoppedWorkIds.has(item.id)) await updateWork(item.id, { status: 'waiting', waitReason: waitReason ?? current.waitReason ?? 'resume-failed', evidence: appendEvidence(current.evidence, `Resume failed: ${String(error?.message ?? error)}`) })
        return
      }
      const latest = store.workItems.get(item.id)
      if (stoppedWorkIds.has(item.id) || latest?.stopGeneration !== runtime.generation || latest.status === 'stopped' || !host.writable()) {
        goals.disarm(agent)
        return
      }
      runtime.goalRef = { id: resumed.id, revision: resumed.revision }
      runtime.ready = true
      return updateWork(item.id, { status: 'active', waitReason: undefined, questionId: undefined })
    })
  }

  async function delegateWork(args, exec) {
    await ensureWritable()
    const parentAgent = exec?.agent
    const parentRuntime = bySession.get(parentAgent?.id)
    if (parentRuntime === undefined || parentRuntime.agent !== parentAgent || !parentRuntime.ready) throw new Error('Delegation is available only inside an active autonomy task')
    const parent = store.workItems.get(parentRuntime.workItemId)
    if (parent === undefined || parent.status !== 'active' || parent.stopGeneration !== parentRuntime.generation) throw new Error('The parent task is no longer active')
    const childTarget = host.target(String(args.botId ?? args.bot_id ?? ''), args.roomId ?? args.room_id)
    if (childTarget.botId === parent.target.botId) throw new Error('Delegate to a different Bot so the parent can wait without a resource conflict')
    const currentGoal = goals.get(parentAgent)
    if (!goalMatches(currentGoal, parent.goalRef)) throw new Error('The parent task no longer owns the current Goal')
    if (parent.status === 'waiting') throw new Error('The parent task is already waiting')
    const dependencyExchangeId = randomUUID()
    const child = makeWorkItem({
      target: childTarget,
      objective: args.objective,
      acceptance: args.acceptance,
      allowedScope: args.allowedScope ?? args.allowed_scope ?? '',
      authorizationRef: parent.authorizationRef,
      origin: { kind: 'dependency' },
      returnTo: { botId: parent.target.botId, ...(parent.target.roomId ? { roomId: parent.target.roomId } : {}), sessionId: parent.target.sessionId, audience: 'bot' },
      responsibilityId: parent.responsibilityId,
      parentWorkItemId: parent.id,
      dependencyWorkItemId: parent.id,
      dependencyExchangeId,
      dependencySessionId: parent.target.sessionId,
      maxGoalRounds: args.maxGoalRounds ?? args.max_goal_rounds ?? DEFAULT_ROUNDS,
      resources: args.resources ?? [],
    })
    await putWork(child)
    const parentWaiting = await serial(parent.id, async () => updateWork(parent.id, {
      status: 'waiting',
      waitReason: 'dependency',
      dependencyWorkItemId: child.id,
      dependencyExchangeId,
      dependencySessionId: childTarget.sessionId,
    }))
    parentRuntime.ready = false
    try {
      const blocked = goals.block(parentAgent, { id: currentGoal.id, revision: currentGoal.revision }, {
        code: 'waiting-for-dependency',
        message: `Waiting for delegated work item ${child.id} from ${childTarget.botId}.`,
      })
      parentRuntime.goalRef = { id: blocked.id, revision: blocked.revision }
      await updateWork(parentWaiting.id, { goalRef: parentRuntime.goalRef })
    } catch (error) {
      await serial(parent.id, () => updateWork(parent.id, { status: 'active', waitReason: undefined, dependencyWorkItemId: undefined, dependencyExchangeId: undefined, dependencySessionId: undefined }))
      parentRuntime.ready = true
      throw error
    }
    void pump().catch(() => {})
    return { parentWorkItemId: parent.id, childWorkItemId: child.id, exchangeId: dependencyExchangeId, status: 'waiting' }
  }

  async function acceptDependencyResult(sessionId, source, text) {
    if (typeof source?.replyTo !== 'string') return
    const agent = agents.get(sessionId)
    const parent = [...store.workItems.entries()].map(([, item]) => item).find(item => item.status === 'waiting'
      && item.waitReason === 'dependency'
      && item.target.sessionId === sessionId
      && item.dependencyExchangeId === source.replyTo)
    if (parent === undefined) return
    const child = store.workItems.get(parent.dependencyWorkItemId)
    if (child === undefined || child.status !== 'complete' || child.dependencyExchangeId !== source.replyTo) return
    if (source.senderSessionId !== child.target.botId || source.exchangeId !== child.delivery.id || source.role !== 'reply') return
    const recorded = agent?.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? (event.data.inserted ?? []) : [])
      .findLast(message => message.source?.kind === 'bot' && message.source.role === 'reply'
        && message.source.replyTo === source.replyTo && message.source.exchangeId === child.delivery.id
        && message.source.senderSessionId === child.target.botId)
    if (recorded === undefined) return
    text = messageText(recorded)
    const currentParent = await serial(parent.id, async () => {
      const current = store.workItems.get(parent.id)
      if (current?.status !== 'waiting' || current.dependencyExchangeId !== source.replyTo || current.stopGeneration !== parent.stopGeneration) return undefined
      return updateWork(parent.id, { result: text })
    })
    const runtime = bySession.get(sessionId)
    if (currentParent !== undefined && runtime?.workItemId === parent.id) await resumeBoundGoal(currentParent, runtime, 'dependency-answer')
  }

  async function answerQuestion(sessionId, question, answer) {
    await ensureReady()
    const item = [...store.workItems.entries()].map(([, work]) => work).find(work => work.target.sessionId === sessionId
      && work.status === 'waiting' && work.waitReason === 'question' && work.questionId === question.id)
    if (item === undefined) return false
    if (!nonEmpty(question.question) || answer === undefined || answer === null) return false
    return serial(item.id, async () => {
      const current = store.workItems.get(item.id)
      if (current?.status !== 'waiting' || current.waitReason !== 'question' || current.questionId !== question.id || current.stopGeneration !== item.stopGeneration) return false
      return true
    })
  }

  async function onQuestionMessage(sessionId, message) {
    const questionId = readQuestionId(message)
    if (questionId === undefined) return
    const item = [...store.workItems.entries()].map(([, work]) => work).find(work => work.target.sessionId === sessionId
      && work.status === 'waiting' && work.waitReason === 'question' && work.questionId === questionId)
    if (item === undefined) return
    const runtime = bySession.get(sessionId)
    if (runtime === undefined || runtime.workItemId !== item.id) return
    await resumeBoundGoal(item, runtime, 'question-answer')
  }

  async function questionOpened(sessionId, question) {
    await ensureReady()
    const runtime = bySession.get(sessionId)
    if (runtime === undefined || !runtime.ready || typeof question?.id !== 'string') return
    await serial(runtime.workItemId, async () => {
      const item = store.workItems.get(runtime.workItemId)
      if (stoppedWorkIds.has(runtime.workItemId) || item === undefined || item.status !== 'active' || item.stopGeneration !== runtime.generation) return
      const goal = goals.get(runtime.agent)
      if (!goalMatches(goal, item.goalRef)) return
      const waiting = await updateWork(item.id, { status: 'waiting', waitReason: 'question', questionId: question.id })
      runtime.ready = false
      const blocked = goals.block(runtime.agent, { id: goal.id, revision: goal.revision }, {
        code: 'needs-user-input',
        message: String(question.question ?? 'The task needs an answer from the user.'),
      })
      await updateWork(item.id, { goalRef: { id: blocked.id, revision: blocked.revision } })
      return waiting
    })
  }

  function queueRuntimeWrite(runtime, action) {
    const pending = runtime.pendingWrites.then(action)
    runtime.pendingWrites = pending
    void pending.catch(error => { runtime.persistenceError = error })
    return pending
  }

  function locateWorkForGoal(sessionId, goalId) {
    if (typeof goalId !== 'string') return undefined
    return [...store.workItems.entries()].map(([, item]) => item).find(item => item.target.sessionId === sessionId && item.goalRef?.id === goalId)
  }

  function onGoalRound(sessionId, event) {
    const source = event.data?.source
    const runtime = bySession.get(sessionId)
    if (source?.kind !== 'goal' || runtime === undefined || source.goalId !== runtime.goalRef?.id) return
    if (!Number.isSafeInteger(source.round) || source.round < 1 || source.round <= runtime.roundsStarted) return
    const expected = runtime.roundsStarted + 1
    runtime.roundsStarted = source.round
    runtime.pendingRoundWrite = queueRuntimeWrite(runtime, () => serial(runtime.workItemId, async () => {
      const current = store.workItems.get(runtime.workItemId)
      if (stoppedWorkIds.has(runtime.workItemId) || current === undefined || current.stopGeneration !== runtime.generation || current.status === 'stopped') return
      if (source.round !== expected) throw new Error(`Goal round sequence jumped from ${expected - 1} to ${source.round}`)
      const goal = goals.get(runtime.agent)
      if (goal === undefined || goal.id !== source.goalId || goal.roundsStarted !== source.round) throw new Error('Native Goal round does not match the live Goal view')
      const consumedRounds = runtime.goalRoundBase + source.round
      if (consumedRounds > current.maxGoalRounds) throw new Error('Native Goal exceeded the saved total round budget')
      await updateWork(runtime.workItemId, { consumedRounds, goalRef: { id: goal.id, revision: goal.revision } })
      runtime.goalRef = { id: goal.id, revision: goal.revision }
    }))
  }

  function onGoalChange(sessionId, event) {
    if (!accepting || disposed) return
    const data = event.data
    const goal = data?.goal
    const goalId = goal?.id ?? data?.cleared?.id
    const item = locateWorkForGoal(sessionId, goalId)
    if (item === undefined) return
    const runtime = bySession.get(sessionId)
    if (runtime === undefined || runtime.workItemId !== item.id || runtime.generation !== item.stopGeneration) return
    if (data.operation === 'complete') runtime.terminal = { phase: 'complete', ref: { id: goal.id, revision: goal.revision } }
    if (data.operation === 'block' && !['question', 'dependency', 'part-move'].includes(item.waitReason)) runtime.terminal = { phase: 'blocked', ref: { id: goal.id, revision: goal.revision }, reason: goal.blockedReason }
    if (data.operation === 'pause') runtime.terminal = { phase: 'paused', ref: { id: goal.id, revision: goal.revision } }
    if (data.operation === 'clear') runtime.terminal = { phase: 'cleared', ref: data.cleared }
    if (['complete', 'block', 'pause', 'clear'].includes(data.operation)) runtime.ready = false
    queueRuntimeWrite(runtime, () => serial(item.id, async () => {
      const current = store.workItems.get(item.id)
      if (stoppedWorkIds.has(item.id) || current === undefined || current.stopGeneration !== runtime.generation || current.status === 'stopped') return
      if (data.operation === 'clear') return updateWork(item.id, { status: 'waiting', waitReason: 'goal-cleared', goalRef: undefined })
      if (data.operation === 'create' || goal === undefined || current.goalRef?.id !== goal.id) return
      const goalRef = { id: goal.id, revision: goal.revision }
      if (data.operation === 'complete') return updateWork(item.id, { status: 'complete', goalRef, waitReason: undefined })
      if (data.operation === 'block') {
        if (['question', 'dependency', 'part-move'].includes(current.waitReason)) return updateWork(item.id, { goalRef })
        return updateWork(item.id, { status: 'blocked', waitReason: 'native-goal-blocked', goalRef, evidence: appendEvidence(current.evidence, goal.blockedReason?.message) })
      }
      if (data.operation === 'pause') return updateWork(item.id, { status: 'waiting', waitReason: 'native-goal-paused', goalRef })
      if (['edit', 'resume'].includes(data.operation)) return updateWork(item.id, { goalRef })
    }))
  }

  async function finishTurn(sessionId, payload, runtime, turnState) {
    try {
      await runtime.pendingWrites
      await runtime.pendingRoundWrite
    } catch {
      goals.disarm(runtime.agent)
      runtime.ready = false
      return
    }
    if (stoppedWorkIds.has(runtime.workItemId)) {
      goals.disarm(runtime.agent)
      runtime.ready = false
      return
    }
    const goal = goals.get(runtime.agent)
    const current = store.workItems.get(runtime.workItemId)
    if (current === undefined || current.stopGeneration !== runtime.generation || current.status === 'stopped') {
      if (bySession.get(sessionId) === runtime) bySession.delete(sessionId)
      return
    }
    if (goal === undefined || current.goalRef?.id !== goal.id) return
    if (goal.phase === 'active') return
    if (goal.phase === 'paused') {
      await serial(current.id, () => {
        const latest = store.workItems.get(current.id)
        if (latest?.stopGeneration !== current.stopGeneration || latest.status === 'stopped') return
        return updateWork(current.id, { status: 'waiting', waitReason: 'native-goal-paused', goalRef: { id: goal.id, revision: goal.revision } })
      })
      runtime.ready = false
      return
    }
    if (goal.phase === 'blocked' && ['question', 'dependency', 'part-move'].includes(current.waitReason)) return
    const texts = Array.isArray(payload.texts) ? payload.texts.filter(nonEmpty) : turnState.texts
    const result = texts.join('\n\n').trim()
    const status = goal.phase === 'complete' ? 'complete' : 'blocked'
    const finalized = await serial(current.id, () => {
      const latest = store.workItems.get(current.id)
      if (latest?.stopGeneration !== current.stopGeneration || latest.status === 'stopped') return undefined
      return updateWork(current.id, {
        status,
        waitReason: status === 'blocked' ? (current.waitReason ?? 'native-goal-blocked') : undefined,
        goalRef: { id: goal.id, revision: goal.revision },
        ...(result ? { result } : {}),
      })
    })
    runtime.ready = false
    if (bySession.get(sessionId) === runtime) bySession.delete(sessionId)
    if (accepting && finalized !== undefined && finalized.status !== 'stopped') await deliverFinal(finalized)
  }

  function claimTurnResult(sessionId, payload) {
    const turnState = currentTurns.get(sessionId)
    if (turnState?.turn !== payload?.turn || turnState.managed !== true) return false
    const runtime = bySession.get(sessionId)
    if (runtime === undefined || runtime.workItemId !== turnState.workItemId) return true
    turnState.ended = true
    void finishTurn(sessionId, payload, runtime, turnState).catch(() => {})
    return true
  }

  async function dispatchWorkDecision(payload, decision) {
    if (decision.kind !== 'enter') return decision
    let item = [...store.workItems.entries()].map(([, work]) => work).find(work => work.target.sessionId === payload.agent.id && OWNER_ACTIVE.has(work.status))
    const runtime = bySession.get(payload.agent.id)
    for (const message of decision.messages ?? []) {
      const source = message?.source
      if (source?.kind === 'user-question-reply' && item?.waitReason === 'question') {
        const questionId = readQuestionId(message)
        if (questionId === item.questionId && runtime?.workItemId === item.id) {
          await resumeBoundGoal(item, runtime, 'question-answer')
          item = store.workItems.get(item.id)
        }
      }
      if (source?.kind === 'bot' && typeof source.replyTo === 'string' && item?.waitReason === 'dependency') {
        await acceptDependencyResult(payload.agent.id, source, messageText(message))
        item = store.workItems.get(item.id)
      }
    }
    const owned = bySession.get(payload.agent.id)
    if (owned === undefined) return decision
    try {
      await owned.binding
      await owned.pendingWrites
      await owned.pendingRoundWrite
    } catch {
      owned.ready = false
      goals.disarm(payload.agent)
      return { kind: 'reject' }
    }
    if (stoppedWorkIds.has(owned.workItemId)) {
      owned.ready = false
      goals.disarm(payload.agent)
      return { kind: 'reject' }
    }
    const current = store.workItems.get(owned.workItemId)
    // Goal completion precedes the assistant's final tool-result step.
    if (current?.stopGeneration === owned.generation && owned.terminal?.phase === 'complete'
      && current.status === 'complete' && !(decision.messages ?? []).some(message => message.source?.kind === 'goal' && message.source.round > 0)) return decision
    if (current === undefined || current.stopGeneration !== owned.generation || current.status === 'stopped'
      || current.status === 'waiting' || current.status === 'blocked') {
      owned.ready = false
      goals.disarm(payload.agent)
      return { kind: 'reject' }
    }
    if (!owned.ready || current.status !== 'active' || !host.writable() || agents.get(payload.agent.id) !== payload.agent) {
      owned.ready = false
      goals.disarm(payload.agent)
      return { kind: 'reject' }
    }
    let target
    try { target = host.target(current.target.botId, current.target.roomId) } catch { target = undefined }
    if (target?.sessionId !== payload.agent.id || target.sessionId !== current.target.sessionId) {
      owned.ready = false
      goals.disarm(payload.agent)
      await serial(current.id, () => updateWork(current.id, {
        status: 'waiting', waitReason: 'target-changed',
        evidence: appendEvidence(current.evidence, 'The Bot changed parts before this Goal step was admitted.'),
      }))
      return { kind: 'reject' }
    }
    const goal = goals.get(payload.agent)
    const expectedTotal = owned.goalRoundBase + owned.roundsStarted
    const backgroundWait = backgroundWaits.get(payload.agent.id)
    const conversationDuringJob = backgroundWait && goal && backgroundWait.id === goal.id && backgroundWait.revision === goal.revision
      && backgroundWait.generation === current.stopGeneration && goal.activation === 'disarmed'
      && !(decision.messages ?? []).some(message => message.source?.kind === 'goal' && message.source.round > 0)
    if (!goalMatches(goal, current.goalRef) || goal.phase !== 'active' || (goal.activation !== 'armed' && !conversationDuringJob)
      || goal.roundsStarted !== owned.roundsStarted || current.consumedRounds !== expectedTotal
      || ((decision.messages ?? []).some(message => message.source?.kind === 'goal' && message.source.round > 0) && current.consumedRounds >= current.maxGoalRounds)) {
      owned.ready = false
      goals.disarm(payload.agent)
      return { kind: 'reject' }
    }
    return decision
  }

  async function beforeStop(scope) {
    if (scope !== undefined) {
      if (store === undefined) await ensureReady()
      const pendingCompletions = new Set([...bySession.values()].filter(runtime => currentTurns.get(runtime.sessionId)?.managed === true).map(runtime => runtime.workItemId))
      const matching = []
      for (const [id, item] of store.workItems.entries()) {
        if (item.target.botId !== scope.botId || (scope.sessionId && item.target.sessionId !== scope.sessionId)
          || (!['queued', 'activating', 'active', 'waiting'].includes(item.status) && !(item.status === 'complete' && pendingCompletions.has(id)))) continue
        fenceWorkItem(id, item)
        matching.push(id)
      }
      for (const id of matching) {
        await serial(id, async () => {
          const current = store.workItems.get(id)
          if (!current || current.status === 'stopped') return
          await updateWork(id, { status: 'stopped', waitReason: 'user-stop', stopGeneration: current.stopGeneration + 1 })
        })
      }
      return
    }
    if (stopping !== undefined) return stopping
    accepting = false
    stopping = (async () => {
      await ensureReady()
      const cancel = []
      for (const [id, item] of store.workItems.entries()) {
        if (!['queued', 'activating', 'active'].includes(item.status)) continue
        const waiting = await serial(id, async () => {
          const current = store.workItems.get(id)
          if (current === undefined || !['queued', 'activating', 'active'].includes(current.status)) return undefined
          return updateWork(id, { status: 'waiting', waitReason: 'restart', stopGeneration: current.stopGeneration + 1 })
        })
        const runtime = bySession.get(item.target.sessionId)
        if (runtime !== undefined && runtime.workItemId === id) {
          runtime.ready = false
          if (waiting !== undefined) runtime.generation = waiting.stopGeneration
          goals.disarm(runtime.agent)
          if (waiting !== undefined && runtime.agent.status === 'running') cancel.push(runtime.agent)
        } else {
          try {
            const target = host.target(item.target.botId, item.target.roomId)
            const agent = await host.resolve(target)
            const goal = goals.get(agent)
            if (goal !== undefined && goal.id === item.goalRef?.id) {
              goals.disarm(agent)
              if (waiting !== undefined && agent.status === 'running') cancel.push(agent)
            }
          } catch { /* The durable wait record is the restart fence. */ }
        }
      }
      for (const agent of cancel) agent.cancel({ kind: 'hook', reason: 'ds-bot-autonomy/shutdown' })
    })()
    return stopping
  }

  async function dispose() {
    await beforeStop()
    disposed = true
    attachedDisposer?.()
    attachedDisposer = undefined
    for (const runtime of bySession.values()) {
      runtime.ready = false
      try { goals.disarm(runtime.agent) } catch { /* The Agent may already be disposed. */ }
    }
    bySession.clear()
    for (const disposeTool of extensionDisposers.splice(0)) disposeTool?.()
    await store?.close()
  }

  async function handleApi(endpoint, body = {}) {
    switch (endpoint) {
      case 'autonomy-list':
        return listWork({ status: body.status, targetId: body.botId })
      case 'autonomy-get':
        return getWork(body.workItemId ?? body.id)
      case 'autonomy-submit': return submit(body, body, { api: true })
      case 'autonomy-stop': return stop(body.workItemId ?? body.id, body, { api: true })
      case 'autonomy-resume': return resume(body.workItemId ?? body.id, body, { api: true })
      case 'autonomy-responsibilities': {
        const action = body.action ?? 'list'
        if (action === 'list') return listResponsibilities({ targetId: body.botId })
        const { authorizationRef } = apiAuthorization(body)
        if (action === 'create') return createResponsibility(body, body, { api: true, authorizationRef })
        if (action === 'update') return updateResponsibility(body.responsibilityId ?? body.id, body.patch ?? body, body, { api: true, authorizationRef })
        if (action === 'stop' || action === 'delete') return deleteResponsibility(body.responsibilityId ?? body.id, body, { api: true, authorizationRef })
        if (action === 'schedule-create') return createSchedule(body.responsibilityId, body.schedule, body, { api: true, authorizationRef })
        if (action === 'schedule-list') return listSchedules(body.responsibilityId, body, { api: true, authorizationRef })
        if (action === 'schedule-update') return updateSchedule(body.scheduleId, body.patch ?? {}, body, { api: true, authorizationRef })
        if (action === 'schedule-delete') return deleteSchedule(body.scheduleId, body, { api: true, authorizationRef })
        throw new Error('Unsupported DS Bot autonomy responsibility action')
      }
      default: throw new Error('Unsupported DS Bot autonomy endpoint')
    }
  }

  function registerTools(toolCtx) {
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
    const json = value => JSON.stringify(value, null, 2)
    const register = definition => {
      extensionDisposers.push(toolCtx.tools.register(defineTool({ output, ...definition })))
    }
    register({
      name: 'autonomy_submit_work',
      description: 'Start a bounded autonomous work item for a DS Bot, authorized by the current direct human turn.',
      parameters: {
        botId: { type: 'string', required: true }, roomId: { type: 'string' },
        objective: { type: 'string', required: true }, acceptance: { type: 'string', required: true },
        allowedScope: { type: 'string' }, maxGoalRounds: { type: 'integer' }, resources: { type: 'array', items: { type: 'string' } },
      },
      async execute(args, exec) { return json(await submit(args, exec.agent)) },
    })
    register({
      name: 'autonomy_list_work', description: 'List saved autonomous work items.',
      parameters: { status: { type: 'string' }, botId: { type: 'string' } },
      async execute(args) { return json(await listWork({ status: args.status, targetId: args.botId })) },
    })
    register({
      name: 'autonomy_get_work', description: 'Read one saved autonomous work item.',
      parameters: { workItemId: { type: 'string', required: true } },
      async execute(args) { return json(await getWork(args.workItemId)) },
    })
    register({
      name: 'autonomy_stop_work', description: 'Stop an autonomous work item and fence late Goal events.',
      parameters: { workItemId: { type: 'string', required: true } },
      async execute(args, exec) { return json(await stop(args.workItemId, exec.agent)) },
    })
    register({
      name: 'autonomy_resume_work', description: 'Explicitly resume a stopped or waiting work item from this direct human turn.',
      parameters: { workItemId: { type: 'string', required: true } },
      async execute(args, exec) { return json(await resume(args.workItemId, exec.agent)) },
    })
    register({
      name: 'autonomy_manage_responsibilities', description: 'Create, list, update, or stop a saved responsibility for authorized scheduled work.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'stop'] },
        responsibilityId: { type: 'string' }, botId: { type: 'string' }, roomId: { type: 'string' },
        objective: { type: 'string' }, acceptance: { type: 'string' }, allowedScope: { type: 'string' }, resources: { type: 'array', items: { type: 'string' } },
      },
      async execute(args, exec) {
        if (args.action === 'list') return json(await listResponsibilities({ targetId: args.botId }))
        toolAuthorization(exec)
        if (args.action === 'create') return json(await createResponsibility(args, exec.agent))
        if (args.action === 'update') return json(await updateResponsibility(args.responsibilityId, args, exec.agent))
        return json(await deleteResponsibility(args.responsibilityId, exec.agent))
      },
    })
    register({
      name: 'autonomy_manage_schedules', description: 'Create, list, update, or delete a schedule bound to a saved responsibility.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'delete'] },
        responsibilityId: { type: 'string' }, scheduleId: { type: 'string' },
        schedule: { type: 'json' }, patch: { type: 'json' },
      },
      async execute(args, exec) {
        if (args.action === 'list') return json(await listSchedules(args.responsibilityId))
        toolAuthorization(exec)
        if (args.action === 'create') return json(await createSchedule(args.responsibilityId, args.schedule, exec.agent))
        if (args.action === 'update') return json(await updateSchedule(args.scheduleId, args.patch ?? {}, exec.agent))
        return json(await deleteSchedule(args.scheduleId, exec.agent))
      },
    })
    register({
      name: 'autonomy_delegate_work', description: 'Delegate a bounded part of the active autonomy task to a different DS Bot and wait for its verified result.',
      parameters: {
        botId: { type: 'string', required: true }, roomId: { type: 'string' },
        objective: { type: 'string', required: true }, acceptance: { type: 'string', required: true },
        allowedScope: { type: 'string' }, maxGoalRounds: { type: 'integer' }, resources: { type: 'array', items: { type: 'string' } },
      },
      async execute(args, exec) { return json(await delegateWork(args, exec)) },
    })
  }

  function install(innerCtx) {
    const disposers = []
    disposers.push(installResponsiveWork(innerCtx, {
      host, goals, agents, systemPrompt, waits: backgroundWaits,
      managedGoal(agent) {
        const runtime = bySession.get(agent.id)
        const item = runtime?.ready && store?.workItems.get(runtime.workItemId)
        if (!item || item.status !== 'active' || item.stopGeneration !== runtime.generation || stoppedWorkIds.has(item.id)) return undefined
        const goal = goals.get(agent)
        if (!goal || goal.id !== item.goalRef?.id || goal.revision !== item.goalRef?.revision) return undefined
        return { goal, generation: item.stopGeneration }
      },
    }))
    disposers.push(innerCtx.on('agent/pre-step', async (payload, next) => {
      const original = await next()
      try {
        await ensureReady()
        const scheduled = await dispatchScheduleDecision(payload, original)
        return await dispatchWorkDecision(payload, scheduled)
      } catch {
        const runtime = bySession.get(payload.agent?.id)
        if (runtime !== undefined) {
          runtime.ready = false
          try { goals.disarm(payload.agent) } catch { /* The admission fence remains closed. */ }
          return { kind: 'reject' }
        }
        return original
      }
    }))
    disposers.push(innerCtx.on('session/event', (session, event) => {
      const sessionId = session?.id
      if (sessionId === undefined || store === undefined) return
      if (event.type === 'turn/start') {
        const item = [...store.workItems.entries()].map(([, work]) => work).find(work => work.target.sessionId === sessionId && OWNER_ACTIVE.has(work.status))
        currentTurns.set(sessionId, { turn: event.data?.turn, texts: [], managed: item !== undefined, workItemId: item?.id })
        return
      }
      if (event.type === 'assistant/message') {
        const turn = currentTurns.get(sessionId)
        const text = messageText(event.data?.message)
        if (text && turn !== undefined) turn.texts.push(text)
        return
      }
      if (event.type === 'user/message') {
        onGoalRound(sessionId, event)
        const message = { content: event.data?.content, source: event.data?.source, id: event.data?.id }
        void onQuestionMessage(sessionId, message).catch(() => {})
        const source = event.data?.source
        if (source?.kind === 'bot' && typeof source.replyTo === 'string') void acceptDependencyResult(sessionId, source, messageText(message)).catch(() => {})
        return
      }
      if (event.type === 'goal/change') {
        onGoalChange(sessionId, event)
        return
      }
      if (event.type === 'turn/end') {
        if (event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user') {
          const owner = host.owner(sessionId)
          if (owner) void beforeStop({ ...owner, sessionId }).catch(() => {})
        }
        currentTurns.delete(sessionId)
      }
    }))
    disposers.push(innerCtx.on('agent/status', payload => {
      const agent = payload?.agent ?? payload
      if (agent?.status === 'idle') void pump().catch(() => {})
    }))
    if (systemPrompt !== undefined) {
      disposers.push(systemPrompt.section({
        name: 'ds-bot-autonomy:owned-work',
        order: systemPrompt.getSectionOrder('TOOL_GOAL') + 10,
        text: ({ scope } = {}) => {
          const runtime = bySession.get(scope?.id)
          const item = runtime?.ready && store !== undefined ? store.workItems.get(runtime.workItemId) : undefined
          return item?.status === 'active' && item.stopGeneration === runtime.generation ? taskSystemPrompt(item) : ''
        },
      }))
    }
    registerTools(innerCtx)
    return async () => {
      for (const dispose of extensionDisposers.splice(0).reverse()) dispose?.()
      for (const dispose of disposers.reverse()) dispose?.()
    }
  }

  const extension = {
    beforeStop,
    questionOpened,
    questionAnswered: answerQuestion,
    claimTurnResult,
    beginPartMove,
    finishPartMove,
    abortPartMove,
    scheduleMoved,
    ownsRecovery,
    ownsGoal,
    handleApi,
  }
  const api = Object.freeze({
    ready: ensureReady,
    get: getWork,
    list: listWork,
    submit: (input, actor) => submit(input, actor),
    stop: (id, actor) => stop(id, actor),
    resume: (id, actor) => resume(id, actor),
    responsibilities: Object.freeze({
      list: listResponsibilities,
      create: (input, actor) => createResponsibility(input, actor),
      update: (id, patch, actor) => updateResponsibility(id, patch, actor),
      stop: (id, actor) => deleteResponsibility(id, actor),
    }),
    schedules: Object.freeze({
      create: (id, request, actor) => createSchedule(id, request, actor),
      list: id => listSchedules(id),
      update: (id, patch, actor) => updateSchedule(id, patch, actor),
      delete: (id, actor) => deleteSchedule(id, actor),
    }),
    receiveDependency: acceptDependencyResult,
  })

  return {
    api,
    async initialize() {
      await ensureReady()
      attachedDisposer = host.attach(extension)
    },
    install,
    setSchedule(value) { schedule = value },
    beforeStop,
    dispose,
  }
}
