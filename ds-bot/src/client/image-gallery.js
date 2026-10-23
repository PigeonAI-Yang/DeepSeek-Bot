import { outputItems } from './output-items.js'

export async function earlierImagePage(binding, isCurrent, readImages) {
  if (!isCurrent()) throw new Error('ds-bot: image session is no longer available')
  const before = binding.eventSource.getSnapshot().entries.find(entry => entry.type === 'event')?.event.seq
  await binding.session.loadOlder()
  if (!isCurrent()) throw new Error('ds-bot: image session is no longer available')
  const hasMore = binding.session.getSnapshot()?.hasMore === true
  const after = binding.eventSource.getSnapshot().entries.find(entry => entry.type === 'event')?.event.seq
  if (hasMore && (before === after || after === undefined)) throw new Error('ds-bot: older image history did not advance')
  return { items: readImages(), hasMore }
}

function sourceKey(src) {
  if (!src) return undefined
  try {
    const url = new URL(src)
    const path = url.searchParams.get('path')
    if (path && url.pathname.endsWith('/api/file')) {
      const normalized = path.replace(/\\/g, '/')
      return `path:${/^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized}`
    }
  } catch { /* a loader can supply the source later */ }
  return src
}

function fileImageUrl(path, base) {
  if (!path || !base || !/^(?:[a-z]:\/|\/(?!\/))/i.test(path) || /\p{Cc}/u.test(path)) return undefined
  const url = new URL('api/file', base)
  if (!['http:', 'https:', 'dsh-app:'].includes(url.protocol)) return undefined
  url.searchParams.set('path', path)
  return url.href
}

export function conversationImages(snapshot, { cwd, base, peekImage } = {}) {
  const items = outputItems(snapshot, { cwd }).filter(item => item.kind === 'image' && (item.attachment || item.path))
  for (const node of snapshot?.nodes?.values?.() ?? []) {
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    for (const [index, block] of (node.data?.content ?? []).entries()) {
      if (block.type !== 'image' || !block.attachment) continue
      const attachment = block.attachment
      items.push({ key: `user:${node.key ?? node.anchorSeq}:${index}`, attachment, name: attachment.name || 'Image', seq: node.anchorSeq ?? 0 })
    }
  }
  return items.sort((a, b) => a.seq - b.seq).map(item => ({ ...item, src: (item.attachment ? peekImage?.(item.attachment) : undefined) || fileImageUrl(item.path, base) }))
}

export function imageGallery(items, current, rendered = []) {
  const images = []
  const keys = new Map()
  for (const image of [...items, ...rendered]) {
    if (!image.src && !image.attachment) continue
    const attachment = image.attachment
    const attachmentId = attachment?.id ?? attachment?.attachmentId
    const aliases = [image.key, sourceKey(image.src), attachmentId ? `attachment:${attachmentId}:${attachment.variant ?? attachment.variantId ?? ''}` : undefined].filter(Boolean)
    const existing = aliases.map(key => keys.get(key)).find(index => index !== undefined)
    const index = existing ?? images.length
    if (existing === undefined) images.push({ ...image })
    else if (!images[index].src && image.src) images[index].src = image.src
    for (const key of aliases) keys.set(key, index)
  }
  const index = keys.get(current.key) ?? keys.get(sourceKey(current.src)) ?? images.length
  if (index === images.length) images.push({ ...current })
  else images[index] = { ...images[index], ...current }
  return { images, index }
}
