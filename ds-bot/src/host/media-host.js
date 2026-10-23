import { outputItems } from '../client/output-items.js'

export function install(rt) {
  const owner = sessionId => {
    const botId = rt.chatOwners.get(sessionId)
    if (botId !== undefined && rt.chatOf(botId) === sessionId) return Object.freeze({ botId, sessionId })
    const group = rt.groupOwners.get(sessionId)
    if (group && rt.roomOf(group.roomId)?.sessions?.[group.botId] === sessionId) return Object.freeze({ ...group, sessionId })
    return undefined
  }
  const current = async sessionId => {
    await rt.load()
    if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
    const snapshot = owner(sessionId)
    if (!snapshot) throw new Error('The original Bot conversation is unavailable')
    return snapshot
  }
  const attachment = async (sessionId, attachmentId) => {
    await current(sessionId)
    const agent = await rt.resolveAgent(sessionId)
    await current(sessionId)
    let found
    const visit = value => {
      if (!value || typeof value !== 'object' || found) return
      if (value.attachmentId === attachmentId && typeof value.mediaType === 'string' && Number.isInteger(value.width) && Number.isInteger(value.height)) { found = { ...value }; return }
      for (const child of Object.values(value)) visit(child)
    }
    for (const event of agent.session.snapshotEvents()) visit(event.data)
    if (!found) throw new Error('The source image is not in this conversation')
    return found
  }
  const workspaceSource = async (sessionId, locator, maxBytes, signal = new AbortController().signal) => {
    const original = await current(sessionId)
    if (!Number.isSafeInteger(locator?.eventSeq) || typeof locator?.sourceKey !== 'string' || Object.keys(locator).some(key => !['eventSeq', 'sourceKey'].includes(key))) throw new Error('Invalid conversation source locator')
    const agent = await rt.resolveAgent(sessionId)
    const event = agent.session.snapshotEvents().find(event => event.seq === locator.eventSeq && event.type === 'assistant/message')
    if (!event) throw new Error('The source event is no longer in this conversation')
    const cwd = agent.session.header.cwd
    if (!cwd) throw new Error('The conversation has no workspace root')
    const node = { kind: 'assistant-step', anchorSeq: event.seq, data: { blocks: event.data.message.content } }
    const item = outputItems({ nodes: new Map([['source', node]]) }, { cwd }).find(item => item.kind === 'image' && item.key === locator.sourceKey)
    if (!item?.path) throw new Error('The source image is not in this conversation event')
    const files = rt.ctx.get('workspaceFiles')
    if (!files) throw new Error('The public workspace file service is unavailable')
    const scope = { sessionId, workspaceRoot: cwd }
    const before = await files.stat(scope, item.path, signal)
    if (!Number.isSafeInteger(before.bytes) || before.bytes <= 0 || before.bytes > maxBytes) throw new Error('Workspace image byte limit exceeded')
    const read = await files.readBytes(scope, item.path, {}, signal)
    const after = await files.stat(scope, item.path, signal)
    if (!read.eof || read.offset !== 0 || read.data.length !== before.bytes || read.data.length > maxBytes || before.version !== read.version || before.version !== after.version || before.absolutePath !== read.absolutePath || before.absolutePath !== after.absolutePath) throw new Error('The source file changed while opening; reopen the image')
    const latest = await current(sessionId)
    if (latest.botId !== original.botId || latest.roomId !== original.roomId) throw new Error('Conversation changed')
    return { data: Buffer.from(read.data), name: item.name, provenance: { kind: 'session-workspace-file', ...locator, version: read.version, sourceAvailability: 'retained-workspace-original' } }
  }
  rt.ctx.provide('dsBotMediaHost', Object.freeze({ version: 1, owner, current, attachment, workspaceSource }))
}
