// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; a no-output recovery may be picked up three times across restarts.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDOFF_ACK, SOURCE_KIND } from './constants.js'
import { textOf } from './text.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000
// A delivery waiting longer than this was not lost to a restart.
const QUEUED_KEPT_MS = 24 * 60 * 60 * 1000
const QUEUED_MAX = 50
const RESUME_MAX_ATTEMPTS = 3

const resumeAttemptOf = record => Number.isSafeInteger(record?.resumeAttempt) && record.resumeAttempt >= 0
  ? record.resumeAttempt
  : record?.resumed === true ? 1 : 0
const resumeProgressOf = record => typeof record?.resumeProgress === 'boolean'
  ? record.resumeProgress
  : record?.resumed === true
const restartClosed = reason => reason?.kind === 'interrupted'
  || (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed')

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued) }
  } catch {
    return { turns: {}, queued: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean, resumeAttempt?:number, resumeProgress?:boolean}>} */
  let turns = { ...interrupted.turns }
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = { ...interrupted.queued }
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Written in place: a rename over the file fails on Windows while anything reads
    // it, and a torn write only loses what one restart would pick up.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      await writeFile(file, snapshot, 'utf8')
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return sessionId
    }
    return undefined
  }

  const forgetResumeQueued = (sessionId, exchangeId) => {
    const list = queued[sessionId] ?? []
    const rest = list.filter(item => item.args?.resumed !== true || (exchangeId !== undefined && item.args.exchangeId !== exchangeId))
    if (rest.length === list.length) return
    queued = { ...queued }
    if (rest.length === 0) delete queued[sessionId]
    else queued[sessionId] = rest
    persist()
  }

  const updateQueuedAttempt = (exchangeId, resumeAttempt) => {
    let changed = false
    for (const [sessionId, list] of Object.entries(queued)) {
      if (!list.some(item => item.args?.exchangeId === exchangeId)) continue
      queued = { ...queued, [sessionId]: list.map(item => item.args?.exchangeId === exchangeId
        ? { ...item, args: { ...item.args, resumeAttempt } }
        : item) }
      changed = true
    }
    if (changed) persist()
  }

  const clearRecovery = (sessionId) => {
    update(sessionId, () => undefined)
    forgetResumeQueued(sessionId)
  }

  const deliver = rt.deliver
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    // Noted before it is sent: a turn may take it up before the send returns.
    const prior = (queued[sessionId] ?? []).find(item => item.args?.exchangeId === noted.exchangeId)
    const pendingArgs = { ...noted }
    if (noted.resumed === true) {
      const currentAttempt = resumeAttemptOf(turns[sessionId] ?? noted)
      pendingArgs.resumeAttempt = currentAttempt
    }
    if (prior === undefined) {
      queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: pendingArgs }].slice(-QUEUED_MAX) }
      persist()
    }
    try {
      return await deliver(noted)
    } catch (error) {
      if (noted.resumed !== true) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ message } = {}) => {
    if (message?.source?.kind !== SOURCE_KIND || !message.source.exchangeId) return
    const sessionId = forgetQueued(message.source.exchangeId)
    if (message.source.resumed === true && sessionId !== undefined) clearRecovery(sessionId)
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // Lifecycle evidence for Sessions with pending work, including a terminal event
  // emitted while resolveAgent repairs the DSH event stream.
  const pendingSessions = new Set([...Object.keys(interrupted.turns), ...Object.keys(interrupted.queued)])
  let firstTurn = pendingSessions.size > 0 ? new Map([...pendingSessions].map(id => [id, undefined])) : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    const source = event.type === 'user/message' ? event.data?.source : undefined
    if (firstTurn?.has(id)) {
      if (event.type === 'turn/start') firstTurn.set(id, { type: 'turn/start' })
      else if (event.type === 'turn/end') firstTurn.set(id, { type: 'turn/end', reason: event.data?.reason })
      else if (event.type === 'user/message') firstTurn.set(id, { type: 'user/message', source })
    }
    if (source?.kind === SOURCE_KIND && source.exchangeId) {
      taken?.add(source.exchangeId)
      forgetQueued(source.exchangeId)
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        const managedAutonomy = rt.autonomyOwnsRecovery?.(id) === true
        update(id, record => ({
          botId,
          ...(owner ? { roomId: owner.roomId } : {}),
          since: event.time ?? Date.now(),
          ...(managedAutonomy ? { managedAutonomy: true } : {}),
          ...(record?.trigger ? { trigger: record.trigger } : {}),
          ...(record?.approval ? { approval: record.approval } : {}),
          ...(record?.resumed === true ? {
            resumed: true,
            resumeAttempt: resumeAttemptOf(record),
            resumeProgress: resumeProgressOf(record),
          } : {}),
        }))
        break
      }
      case 'user/message': {
        const resumed = source?.kind === SOURCE_KIND && source.resumed === true
        if (!resumed) {
          forgetResumeQueued(id)
          update(id, record => (record === undefined ? record : {
            botId: record.botId,
            ...(record.roomId !== undefined ? { roomId: record.roomId } : {}),
            since: record.since,
            ...(record.managedAutonomy === true ? { managedAutonomy: true } : {}),
            ...(source?.kind === SOURCE_KIND ? { trigger: triggerOf(source) } : {}),
          }))
          break
        }
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined ? record : {
          ...record,
          trigger: triggerOf(info ?? source),
          resumed: true,
          resumeAttempt: resumeAttemptOf({ ...record, resumed: true, resumeAttempt: source.resumeAttempt }),
          resumeProgress: source.resumeAttempt === undefined ? true : (record.resumeProgress === true),
        }))
        break
      }
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content)
        if (text === '' || text === HANDOFF_ACK) break
        const info = rt.live.get(id)?.info
        update(id, record => (record?.resumed !== true || info?.resumed !== true
          || (info.resumeAttempt !== undefined && info.resumeAttempt !== resumeAttemptOf(record))
          || resumeProgressOf(record) ? record : { ...record, resumeProgress: true }))
        break
      }
      case 'tool/result': {
        const info = rt.live.get(id)?.info
        if (event.data?.callId === undefined) break
        update(id, record => (record?.resumed !== true || info?.resumed !== true
          || (info.resumeAttempt !== undefined && info.resumeAttempt !== resumeAttemptOf(record))
          || resumeProgressOf(record) ? record : { ...record, resumeProgress: true }))
        break
      }
      case 'turn/end': {
        const reason = event.data?.reason
        if (restartClosed(reason)) break
        clearRecovery(id)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  rt.noteResumeDispatch = async (sessionId, { resumeAttempt, exchangeId, source, resent = false, botId, roomId } = {}) => {
    const current = turns[sessionId]
    if (current?.managedAutonomy === true || rt.autonomyOwnsRecovery?.(sessionId) === true) return undefined
    const requested = Number.isSafeInteger(resumeAttempt) && resumeAttempt > 0 ? resumeAttempt : undefined
    const baseAttempt = Math.max(resumeAttemptOf(current), requested ?? 0)
    const attempt = resent ? baseAttempt + 1 : requested ?? baseAttempt + 1
    if (attempt > RESUME_MAX_ATTEMPTS) return undefined
    update(sessionId, record => ({
      ...record,
      botId: record?.botId ?? botId,
      ...(record?.roomId !== undefined || roomId === undefined ? (record?.roomId !== undefined ? { roomId: record.roomId } : {}) : { roomId }),
      since: record?.since ?? Date.now(),
      trigger: source ? triggerOf(source) : record?.trigger,
      resumed: true,
      resumeAttempt: attempt,
      resumeProgress: false,
    }))
    if (exchangeId) updateQueuedAttempt(exchangeId, attempt)
    await writing
    return attempt
  }

  async function resumeTurn(sessionId, record) {
    if (record.managedAutonomy === true) return
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const canContinue = resumeAttemptOf(record) < RESUME_MAX_ATTEMPTS && !resumeProgressOf(record)
    const text = resumeText(record)
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id)) return
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      if (!canContinue) return
      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, resumeAttempt: resumeAttemptOf(record) + 1, ...(record.trigger?.exchangeId ? { exchangeId: record.trigger.exchangeId } : {}), text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return
    }
    if (!canContinue) return
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, resumeAttempt: resumeAttemptOf(record) + 1, text })
      return
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, role: 'resume', resumed: true, resumeAttempt: resumeAttemptOf(record) + 1, ...(record.trigger?.exchangeId ? { exchangeId: record.trigger.exchangeId } : {}), text, ...(trigger?.work ? { work: trigger.work } : {}) })
  }

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again.
  async function resendQueued(sessionId, list, recoveryAttempted, recoveryWaiting) {
    // A Session that moved on to a new part since is reached at its current one.
    const current = (args) => {
      if (rt.isBotSession(sessionId)) return sessionId
      return args.roomId === undefined ? rt.chatOf(args.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId]
    }
    const fresh = list.filter(item => Date.now() - item.at < QUEUED_KEPT_MS && rt.botOf(item.args?.toId) !== undefined
      && current(item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
    if (fresh.length === 0) return
    const target = current(fresh[0].args)
    const agent = await rt.resolveAgent(target)
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source?.exchangeId))
    for (const { args } of fresh) {
      if (!queued[sessionId]?.some(item => item.args.exchangeId === args.exchangeId)
        || waiting.has(args.exchangeId) || taken?.has(args.exchangeId) === true) {
        if (args.resumed === true && waiting.has(args.exchangeId)) recoveryWaiting.add(target)
        continue
      }
      if (args.resumed === true) {
        if (recoveryAttempted.has(target) || recoveryWaiting.has(target)) continue
        const record = turns[target]
        const attempt = Math.max(resumeAttemptOf(record), resumeAttemptOf(args))
        if (record?.managedAutonomy === true || rt.autonomyOwnsRecovery?.(target) === true) {
          recoveryWaiting.add(target)
          continue
        }
        if (agent.status === 'running' || ['turn/start', 'user/message'].includes(firstTurn?.get(target)?.type)) {
          recoveryWaiting.add(target)
          continue
        }
        if (resumeProgressOf(record) || (args.resumeAttempt === undefined && (record === undefined || record.resumed === true))) {
          forgetResumeQueued(sessionId, args.exchangeId)
          continue
        }
        if (attempt >= RESUME_MAX_ATTEMPTS) {
          if (args.roomId !== undefined) {
            const room = rt.roomOf(args.roomId)
            const bot = rt.botOf(args.toId)
            if (room !== undefined && bot !== undefined) await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, again: true })
          }
          forgetResumeQueued(sessionId, args.exchangeId)
          clearRecovery(target)
          continue
        }
        if (args.roomId !== undefined) {
          const room = rt.roomOf(args.roomId)
          const bot = rt.botOf(args.toId)
          if (room !== undefined && bot !== undefined) await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, again: true })
        }
        recoveryAttempted.add(target)
        await rt.deliver({ ...args, sessionId: current(args), steer: false, resent: true })
        continue
      }
      await rt.deliver({ ...args, sessionId: current(args), steer: false, resent: true })
    }
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    const recoveryAttempted = new Set()
    const recoveryWaiting = new Set()
    // Agents and inboxes are read before anything wakes their Sessions.
    for (const [sessionId, list] of Object.entries(interrupted.queued)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list, recoveryAttempted, recoveryWaiting).catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }

    for (const sessionId of Object.keys(interrupted.turns)) {
      let record = turns[sessionId]
      if (record === undefined || recoveryAttempted.has(sessionId) || recoveryWaiting.has(sessionId)) continue
      let observed = firstTurn?.get(sessionId)
      if (observed?.type === 'turn/end' && !restartClosed(observed.reason)) {
        clearRecovery(sessionId)
        continue
      }
      if (observed?.type === 'turn/start' || observed?.type === 'user/message') continue

      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      observed = firstTurn?.get(sessionId)
      record = turns[sessionId]
      if (record === undefined) continue
      if (observed?.type === 'turn/end' && !restartClosed(observed.reason)) {
        clearRecovery(sessionId)
        continue
      }
      if (observed?.type === 'turn/start' || observed?.type === 'user/message' || agent?.status === 'running') continue
      if (record.managedAutonomy === true || rt.autonomyOwnsRecovery?.(sessionId) === true) continue

      if (resumeProgressOf(record) || resumeAttemptOf(record) >= RESUME_MAX_ATTEMPTS) {
        await resumeTurn(sessionId, record).catch(error => rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error))
        clearRecovery(sessionId)
        continue
      }
      recoveryAttempted.add(sessionId)
      await resumeTurn(sessionId, record).catch(error => rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error))
    }

    interrupted = { turns: {}, queued: {} }
    taken = undefined
    firstTurn = undefined
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    const timer = pending ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS) : undefined
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
