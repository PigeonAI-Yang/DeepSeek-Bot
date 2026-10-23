import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Narrow adapter for the optional ds-bot-autonomy package. The package receives
// snapshots and operations here, never the DS Bot runtime or its mutable maps.
export function install(rt) {
  const { ctx, state } = rt
  let extension
  let disposed = false

  const ready = async () => {
    await rt.load()
    return true
  }
  const writable = () => !disposed && rt.readOnly() === undefined
  const target = (botId, roomId) => {
    if (typeof botId !== 'string' || botId === '') throw new Error('A Bot is required')
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error('Unknown Bot')
    let sessionId
    if (roomId !== undefined) {
      const room = rt.roomOf(roomId)
      if (room === undefined || !room.members.includes(botId)) throw new Error('The Bot is not in that group chat')
      sessionId = room.sessions?.[botId]
    } else {
      sessionId = rt.chatOf(botId)
    }
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('The current Session is unavailable')
    return Object.freeze({ botId, ...(roomId === undefined ? {} : { roomId }), sessionId })
  }
  const owner = sessionId => {
    const botId = rt.chatOwners.get(sessionId)
    if (botId !== undefined && rt.chatOf(botId) === sessionId) return Object.freeze({ botId, sessionId })
    const roomOwner = rt.groupOwners.get(sessionId)
    if (roomOwner !== undefined && rt.roomOf(roomOwner.roomId)?.sessions?.[roomOwner.botId] === sessionId) {
      return Object.freeze({ botId: roomOwner.botId, roomId: roomOwner.roomId, sessionId })
    }
    return undefined
  }
  const assertCurrent = snapshot => {
    if (!writable()) throw new Error(rt.readOnly() ?? 'DS Bot is stopping')
    const current = target(snapshot.botId, snapshot.roomId)
    if (current.sessionId !== snapshot.sessionId) throw new Error('The Bot moved to a different Session')
    return current
  }
  const resolve = async snapshot => {
    await ready()
    const current = assertCurrent(snapshot)
    await rt.ensureCapabilities(current.sessionId)
    const agent = await rt.resolveAgent(current.sessionId)
    assertCurrent(current)
    return agent
  }
  const readDelivery = async (id, snapshot) => {
    await ready()
    const current = assertCurrent(snapshot)
    const agent = await rt.resolveAgent(current.sessionId)
    const inbox = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
      .find(message => message.source?.exchangeId === id)
    if (inbox !== undefined) {
      await ctx.sessions.flush(agent.session)
      return { state: 'receipt', receipt: { exchangeId: id, messageId: inbox.id, sessionId: current.sessionId } }
    }
    const event = agent.session.snapshotEvents().findLast(item => (item.type === 'user/message' && item.data?.source?.exchangeId === id)
      || (item.type === 'agent/inbox/spliced' && item.data?.inserted?.some(message => message.source?.exchangeId === id)))
    if (event !== undefined) {
      await ctx.sessions.flush(agent.session)
      return { state: 'receipt', receipt: { exchangeId: id, messageId: `${current.sessionId}:${event.seq}`, sessionId: current.sessionId } }
    }
    const recorded = state.exchanges.some(item => item.id === id && item.to === current.botId)
    return { state: recorded ? 'ambiguous' : 'missing' }
  }
  const deliver = async request => {
    if (typeof request?.id !== 'string' || request.id === '') throw new Error('A stable delivery id is required')
    if (!['request', 'reply', 'report'].includes(request.role)) throw new Error('Unsupported delivery role')
    if (typeof request.text !== 'string' || request.text.trim() === '') throw new Error('Delivery text is required')
    const current = assertCurrent(request.target)
    const prior = await readDelivery(request.id, current)
    if (prior.state !== 'missing') return prior
    try {
      if (request.audience === 'user') {
        const agent = await rt.resolveAgent(current.sessionId)
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `[Result from ${rt.botOf(request.fromId)?.name ?? 'Bot'}]\n${request.text}` }],
          source: { kind: 'bot', form: 'relay', role: 'report', exchangeId: request.id, audience: 'user', ...(request.fromId ? { senderSessionId: request.fromId } : {}) },
        }), { surfaceOp: 'append' })
        await ctx.sessions.flush(agent.session)
        return readDelivery(request.id, current)
      }
      await rt.deliver({
        toId: current.botId,
        sessionId: current.sessionId,
        text: request.text,
        role: request.role,
        exchangeId: request.id,
        ...(request.fromId ? { fromId: request.fromId } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(request.audience === 'user' ? { audience: 'user' } : {}),
      })
    } catch (error) {
      const reconciled = await readDelivery(request.id, current).catch(() => ({ state: 'ambiguous' }))
      if (reconciled.state !== 'missing') return reconciled
      throw error
    }
    const receipt = await readDelivery(request.id, current)
    return receipt.state === 'missing' ? { state: 'ambiguous' } : receipt
  }
  const attach = next => {
    if (disposed) throw new Error('DS Bot autonomy host is stopping')
    if (extension !== undefined) throw new Error('The autonomy extension is already attached')
    extension = next
    return () => { if (extension === next) extension = undefined }
  }
  const invoke = (name, ...args) => extension?.[name]?.(...args)
  ctx.inject?.(['goals'], scope => {
    const goals = scope.goals
    const original = goals.resume
    function resume(agent, ref) {
      const invocation = this.ctx?.invocation
      if (invocation?.service === 'goals' && invocation.request?.namespace === 'goals'
        && invocation.request?.method === 'resume' && owner(agent?.id)) {
        if (invocation.peer?.principal?.kind !== 'owner' || invocation.signal.aborted) throw new RemoteError('bot/refused', 'Only the current owner can resume this autonomous task', {})
        const result = invoke('resumeNativeGoal', agent, ref, {
          signal: invocation.signal,
          resume: (nextRef = ref) => Reflect.apply(original, this, [agent, nextRef]),
        })
        if (result !== undefined) return Promise.resolve(result).catch(error => {
          if (error?.isDSHRemoteError) throw error
          throw new RemoteError('bot/refused', String(error?.message ?? error), {}, { cause: error })
        })
      }
      return Reflect.apply(original, this, [agent, ref])
    }
    goals.resume = resume
    scope.effect(() => () => { if (goals.resume === resume) goals.resume = original }, 'ds-bot: native Goal resume')
  })
  const question = (snapshot, id) => {
    const current = assertCurrent(snapshot)
    const saved = state.questions[current.sessionId]
    return saved?.id === id ? structuredClone(saved) : undefined
  }
  const closeQuestion = async (snapshot, id) => {
    const current = assertCurrent(snapshot)
    if (state.questions[current.sessionId]?.id !== id) return
    delete state.questions[current.sessionId]
    await rt.save()
  }
  const pendingQuestion = snapshot => Boolean(state.questions[assertCurrent(snapshot).sessionId])
  const service = Object.freeze({ version: 1, ready, writable, target, owner, resolve, deliver, readDelivery, attach, question, closeQuestion, pendingQuestion })

  Object.assign(rt, {
    autonomyOwnerResumeUnstarted: (...args) => {
      if (typeof extension?.resumeUnstartedFromOwner !== 'function') throw new Error('DS Bot autonomy is not available')
      return invoke('resumeUnstartedFromOwner', ...args)
    },
    autonomyOwnerDismissUnstarted: (...args) => {
      if (typeof extension?.dismissUnstartedFromOwner !== 'function') throw new Error('DS Bot autonomy is not available')
      return invoke('dismissUnstartedFromOwner', ...args)
    },
    autonomyBeforeStop: (...args) => invoke('beforeStop', ...args),
    autonomyOwnsQuestion: (sessionId, id) => invoke('ownsQuestion', sessionId, id) === true,
    autonomyQuestionOpened: (...args) => invoke('questionOpened', ...args),
    autonomyQuestionAnswered: (...args) => invoke('questionAnswered', ...args),
    autonomyClaimTurnResult: (...args) => invoke('claimTurnResult', ...args) === true,
    autonomyBeginPartMove: (...args) => invoke('beginPartMove', ...args),
    autonomyFinishPartMove: (...args) => invoke('finishPartMove', ...args),
    autonomyAbortPartMove: (...args) => invoke('abortPartMove', ...args),
    autonomyScheduleMoved: (...args) => invoke('scheduleMoved', ...args),
    autonomyOwnsRecovery: sessionId => invoke('ownsRecovery', sessionId) === true,
    autonomyOwnsGoal: (sessionId, goalId) => !disposed && typeof sessionId === 'string' && typeof goalId === 'string'
      && invoke('ownsGoal', sessionId, goalId) === true,
    autonomyEndpoint: (...args) => {
      if (typeof extension?.handleApi !== 'function') throw new Error('DS Bot autonomy is not available')
      return invoke('handleApi', ...args)
    },
  })
  ctx.provide('dsBotAutonomyHost', service)
  ctx.effect(() => async () => {
    disposed = true
    await invoke('beforeStop')
    extension = undefined
  }, 'ds-bot: autonomy host')
}
