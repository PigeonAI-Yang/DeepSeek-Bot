import { imageInspections } from './image-inspections.js'
import { toolArgs, toolName } from './text.js'

const ARGUMENT_KEYS = ['file_path', 'path', 'cwd', 'url', 'query', 'q', 'pattern', 'command', 'cmd', 'code', 'description', 'workdir']
const PRIVATE_TOOLS = new Set([
  'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group',
  'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret',
  'ask_user_question', 'show_view', 'read_group_chat', 'remember', 'forget',
])
const PRIVATE_KEY = /token|key|password|secret|authorization/i
const hasDedicatedCall = call => call && (PRIVATE_TOOLS.has(toolName(call)) || (call.subCalls ?? []).some(hasDedicatedCall))
const INTERNAL_KINDS = new Set(['request-prompt', 'system-prompt', 'system-message', 'turn-process'])

function safeValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(safeValue)
  if (typeof value !== 'object') return undefined
  const safe = {}
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) safe[key] = '[redacted]'
    else {
      const next = safeValue(nested)
      if (next !== undefined) safe[key] = next
    }
  }
  return safe
}

function statusOf(call) {
  if (call.kind === 'tool-result') return call.isError || (call.error !== undefined && call.error !== null) ? 'failed' : 'completed'
  if (call.phase === 'preparing') return 'preparing'
  if (call.phase === 'start') return 'running'
  return 'unclassified'
}

function selectedArgs(call) {
  const values = toolArgs(call)
  const selected = {}
  for (const key of ARGUMENT_KEYS) {
    const value = values.value(key)
    if (value === undefined) continue
    const safe = safeValue(value)
    if (safe !== undefined) selected[key] = safe
  }
  return selected
}

function objectLabel(args) {
  for (const key of ARGUMENT_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const firstLine = value.split(/\r?\n/, 1)[0].trim()
    const chars = [...firstLine]
    return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : firstLine
  }
  return undefined
}

function textContent(call) {
  if (call.phase === 'preparing') return ''
  return (Array.isArray(call.content) ? call.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function imageCallIds(root) {
  return new Set(imageInspections(root).map(image => image.key.slice(0, image.key.lastIndexOf(':'))))
}

export function toolRecords(root) {
  const records = []
  const callsWithImages = imageCallIds(root)
  const seen = new Set()

  const visit = (call, path) => {
    if (!call || typeof call !== 'object') return
    const identity = call.callId ?? call
    if (seen.has(identity)) return
    seen.add(identity)
    const rawName = toolName(call)
    const name = typeof rawName === 'string' && rawName ? rawName : undefined
    if (name && PRIVATE_TOOLS.has(name)) return

    const callId = typeof call.callId === 'string' && call.callId ? call.callId : undefined
    const shaped = name !== undefined || callId !== undefined || call.kind === 'tool-result' || typeof call.phase === 'string'
    if (shaped && !((name === 'run_code' || name === undefined) && hasDedicatedCall(call))) {
      const status = statusOf(call)
      const imageAlreadyShown = name === 'read_image' && status === 'completed' && callId && callsWithImages.has(callId)
      if (!imageAlreadyShown) {
        const args = status === 'preparing' ? {} : selectedArgs(call)
        records.push({
          key: callId ? `call:${callId}` : `call:${path}`,
          callId,
          path,
          name: name ?? 'Tool',
          status,
          object: objectLabel(args),
          args,
          output: textContent(call),
        })
      }
    }

    if (Array.isArray(call.subCalls)) {
      call.subCalls.forEach((child, index) => visit(child, `${path}.subCalls.${index}`))
    }
  }

  visit(root, 'root')
  return records
}

export function toolArgumentText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function toolBatchStatus(records) {
  for (const status of ['running', 'preparing']) {
    if (records.some(record => record.status === status)) return status
  }
  if (records.length && records.every(record => record.status === 'failed')) return 'failed'
  if (records.some(record => record.status === 'failed')) return 'partial-failed'
  return records.length && records.every(record => record.status === 'completed') ? 'completed' : 'unclassified'
}

export function toolRuns(snapshot) {
  const runs = new Map()
  const nodes = [...snapshot.nodes.values()].sort((a, b) => a.anchorSeq - b.anchorSeq)
  let pending = []
  let turn
  const flush = () => {
    if (!pending.length) return
    const records = pending.flatMap(item => item.records)
    pending.forEach((item, index) => runs.set(item.node.key, { hidden: index > 0, records }))
    pending = []
  }
  for (const node of nodes) {
    if (node.kind === 'context' && node.data?.source?.kind === 'tool-jobs') continue
    if (INTERNAL_KINDS.has(node.kind) || (node.visibility === 'hidden' && !['tool-call', 'turn-trigger', 'steering'].includes(node.kind))) continue
    const nextTurn = node.location?.turn?.turn ?? node.data?.turn ?? node.data?.root?.turn
    if (nextTurn !== turn) flush()
    turn = nextTurn
    const blocks = node.data?.blocks ?? []
    if (node.kind === 'assistant-step' && blocks.every(block => block.kind === 'reasoning' || block.kind === 'tool-call' || (block.kind === 'text' && !block.text.trim()))) continue
    if (node.kind === 'tool-call' && nextTurn !== undefined && !hasDedicatedCall(node.data.root) && !imageInspections(node.data.root).length) {
      const records = toolRecords(node.data.root)
      if (records.length) {
        pending.push({ node, records })
        continue
      }
    }
    flush()
  }
  flush()
  return runs
}

export function activeToolRecords(snapshot) {
  const active = []
  const visit = call => {
    if (!call || PRIVATE_TOOLS.has(toolName(call))) return
    if (call.phase === 'start' || call.phase === 'preparing') {
      const record = toolRecords({ ...call, subCalls: [] })[0]
      if (record) active.push({ ...record, at: call.time })
    }
    for (const child of call.subCalls ?? []) visit(child)
  }
  for (const node of snapshot.nodes.values()) if (node.kind === 'tool-call') visit(node.data.root)
  return active.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

export function activeReplyPeer(snapshot) {
  let peer
  for (const node of snapshot.nodes.values()) {
    const source = node.data?.source
    const turn = node.location?.turn
    if (node.kind !== 'turn-trigger' || turn?.status !== 'open' || source?.kind !== 'bot' || source.role !== 'request') continue
    if (!peer || node.anchorSeq > peer.seq) peer = { id: source.senderSessionId, name: source.senderName, seq: node.anchorSeq }
  }
  return peer
}
