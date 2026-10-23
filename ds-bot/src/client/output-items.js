import { imageInspections } from './image-inspections.js'
import { markdownOutputLinks, toolArgs, toolName } from './text.js'

const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'])
const FILE_OUTPUT_TOOLS = new Set(['edit_file', 'write_file'])

function localPath(value) {
  if (typeof value !== 'string') return undefined
  const path = value.trim().replace(/\\+/g, '/')
  if (!path || path.startsWith('//') || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path))) return undefined
  return path
}

function normalizedPath(path) {
  const drive = /^([a-z]):(?:\/|$)/i.exec(path)
  const absolute = path.startsWith('/') || drive !== null
  const prefix = drive ? `${drive[1]}:` : absolute ? '/' : ''
  const rest = drive ? path.slice(2).replace(/^\/+/, '') : path.replace(/^\/+/, '')
  const segments = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop()
      else if (!absolute) segments.push(segment)
    } else segments.push(segment)
  }
  return `${prefix}${drive && path.slice(2).startsWith('/') ? '/' : ''}${segments.join('/')}`
}

function pathKey(path) {
  if (!path) return undefined
  const normalized = normalizedPath(path)
  const drive = /^([a-z]):(?:\/|$)/i.exec(normalized)
  return drive ? normalized.toLowerCase() : normalized
}

function resolvePath(path, cwd) {
  if (!path || path.startsWith('/') || /^[a-z]:\//i.test(path)) return path
  const base = localPath(cwd)
  if (!base || !(base.startsWith('/') || /^[a-z]:\//i.test(base))) return path
  return normalizedPath(`${base.replace(/\/+$/, '')}/${path}`)
}

function fileName(path) {
  if (typeof path !== 'string' || path === '') return undefined
  return path.slice(path.lastIndexOf('/') + 1) || undefined
}

function extensionOf(path) {
  const name = fileName(path)
  const dot = name?.lastIndexOf('.') ?? -1
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function kindOf(path, attachment) {
  if (attachment?.mediaType?.startsWith?.('image/')) return 'image'
  return IMAGE_EXTENSIONS.has(extensionOf(path)) ? 'image' : 'file'
}

function attachmentKey(attachment) {
  const id = attachment?.id ?? attachment?.attachmentId
  if (id === undefined || id === null || id === '') return undefined
  const variant = attachment?.variant ?? attachment?.variantId ?? ''
  return `attachment:${String(id)}:${String(variant)}`
}

function nameOf({ name, label, attachment, path, kind }) {
  if (typeof name === 'string' && name.trim()) return name.trim()
  if (typeof label === 'string' && label.trim()) return label.trim()
  if (typeof attachment?.name === 'string' && attachment.name.trim()) return attachment.name.trim()
  return fileName(path) ?? (kind === 'image' ? 'Image' : 'File')
}

function successfulResult(call) {
  return call?.kind === 'tool-result' && !call.isError && (call.error === undefined || call.error === null)
}

function visitCalls(root, visit) {
  const walk = call => {
    if (!call || typeof call !== 'object') return
    visit(call)
    for (const child of Array.isArray(call.subCalls) ? call.subCalls : []) walk(child)
  }
  walk(root)
}

function outputCandidate({ path: rawPath, cwd, attachment, label, name, kind, seq, order, source }) {
  const path = resolvePath(localPath(rawPath), cwd)
  const keyPath = pathKey(path)
  const resolvedKind = kind ?? kindOf(path, attachment)
  const identity = keyPath ? `path:${keyPath}` : attachmentKey(attachment) ?? `entry:${source}:${seq}:${order}`
  return {
    key: identity,
    path,
    attachment,
    name: nameOf({ name, label, attachment, path, kind: resolvedKind }),
    kind: resolvedKind,
    seq,
    order,
    nameSource: label ? 'markdown' : 'other',
  }
}

function imageCallPaths(root) {
  const paths = new Map()
  visitCalls(root, call => {
    if (!successfulResult(call) || toolName(call) !== 'read_image' || typeof call.callId !== 'string') return
    const rawPath = toolArgs(call).text('file_path')
    const path = localPath(rawPath)
    paths.set(call.callId, { path, rejected: typeof rawPath === 'string' && path === undefined })
  })
  return paths
}

function outputForNode(node, order, add, cwd) {
  const seq = Number.isFinite(node?.anchorSeq) ? node.anchorSeq : 0
  if (node?.kind === 'assistant-step') {
    for (const block of Array.isArray(node.data?.blocks) ? node.data.blocks : []) {
      const image = (block?.kind === 'image' || block?.type === 'image') && block.attachment && typeof block.attachment === 'object'
      if (image) add(outputCandidate({ attachment: block.attachment, kind: 'image', seq, order: order.value++, source: 'step-image' }))
      if (block?.kind !== 'text' && block?.type !== 'text') continue
      for (const link of markdownOutputLinks(block.text)) {
        const candidate = outputCandidate({ path: link.destination, cwd, label: link.label, seq, order: order.value++, source: 'markdown' })
        if (Number.isSafeInteger(node.data?.finalNode?.seq)) candidate.sourceLocator = { eventSeq: node.data.finalNode.seq, sourceKey: candidate.key }
        add(candidate)
      }
    }
    return
  }
  if (node?.kind !== 'tool-call') return
  const root = node.data?.root
  if (!root || typeof root !== 'object') return

  const paths = imageCallPaths(root)
  for (const image of imageInspections(root)) {
    const callId = image.key.slice(0, image.key.lastIndexOf(':'))
    const path = paths.get(callId)
    if (!path || path.rejected) continue
    add(outputCandidate({ path: path.path, cwd, attachment: image.attachment, name: image.label, kind: 'image', seq, order: order.value++, source: 'read-image' }))
  }

  visitCalls(root, call => {
    if (!successfulResult(call) || !FILE_OUTPUT_TOOLS.has(toolName(call))) return
    const args = toolArgs(call)
    const path = args.text('file_path') ?? args.text('path')
    if (!path) return
    add(outputCandidate({ path, cwd, seq, order: order.value++, source: 'written-file' }))
  })
}

// Collect from every currently materialized ChatSnapshot node, including nodes
// that have no mounted transcript cell. The snapshot owner controls history paging.
export function outputItems(snapshot, { cwd } = {}) {
  const nodes = snapshot?.nodes
  if (!nodes || typeof nodes.values !== 'function') return []
  const candidates = []
  const order = { value: 0 }
  for (const node of nodes.values()) outputForNode(node, order, candidate => candidates.push(candidate), cwd)
  candidates.sort((left, right) => right.seq - left.seq || left.order - right.order)

  const attachmentPaths = new Map()
  for (const candidate of candidates) {
    const key = attachmentKey(candidate.attachment)
    if (key && candidate.path && !attachmentPaths.has(key)) attachmentPaths.set(key, candidate.path)
  }
  for (const candidate of candidates) {
    if (candidate.path) continue
    const knownPath = attachmentPaths.get(attachmentKey(candidate.attachment))
    if (!knownPath) continue
    candidate.path = knownPath
    candidate.key = `path:${pathKey(knownPath)}`
  }

  const items = new Map()
  for (const candidate of candidates) {
    const current = items.get(candidate.key)
    if (!current) {
      items.set(candidate.key, { ...candidate })
      continue
    }
    if (!current.path && candidate.path) current.path = candidate.path
    if (!current.attachment && candidate.attachment) current.attachment = candidate.attachment
    if (candidate.attachment?.mediaType?.startsWith?.('image/')) current.kind = 'image'
    if (candidate.nameSource === 'markdown' && current.nameSource !== 'markdown') {
      current.name = candidate.name
      current.nameSource = 'markdown'
    }
  }
  return [...items.values()]
    .sort((left, right) => right.seq - left.seq || left.order - right.order)
    .map(({ nameSource, order: _order, ...item }) => item)
}
