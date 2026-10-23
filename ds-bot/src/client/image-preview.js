import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, PencilIcon, ReplyIcon, TrashIcon } from './icons.js'
import { imageGallery } from './image-gallery.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

export function captureImageInput(sessions, conversation, sessionId, currentSession) {
  if (sessionId === undefined) return null
  const binding = sessions.binding(sessionId)
  if (!binding || !conversation?.createDrafts || !conversation?.input) return null
  const input = conversation.input.for(binding.ctx)
  return file => {
    if (sessions.binding(sessionId) !== binding || currentSession() !== sessionId) throw new Error(t('Return to the original conversation to add this image.'))
    const drafts = conversation.createDrafts(sessionId, [file])
    try {
      if (!input.addAttachments(drafts.map(draft => draft.id))) throw new Error(t('The input is busy. Please try again.'))
    } catch (error) {
      conversation.releaseDraftAttachments(drafts)
      throw error
    }
    return () => input.focus()
  }
}

function paintStroke(context, stroke) {
  context.strokeStyle = stroke.color
  context.fillStyle = stroke.color
  context.lineWidth = stroke.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  const [first, ...rest] = stroke.points
  if (!rest.length) {
    context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.moveTo(first.x, first.y)
  for (const point of rest) context.lineTo(point.x, point.y)
  context.stroke()
}

export function ImageGallery({ image, gallery, rendered, onClose, captureInput }) {
  const [mediaOverlay, setMediaOverlay] = useState(null)
  const [collection] = useState(() => imageGallery(gallery?.items ?? [], image, rendered))
  const [view, setView] = useState(() => ({ ...collection.images[collection.index], index: collection.index }))
  const desired = useRef(collection.index)
  const generation = useRef(0)
  const stopped = useRef(false)
  const paging = useRef(false)
  const more = useRef(gallery?.hasMore === true)
  const [hasMore, setHasMore] = useState(more.current)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [historyError, setHistoryError] = useState('')
  useEffect(() => {
    stopped.current = false
    return () => { stopped.current = true; generation.current += 1 }
  }, [])
  const select = index => {
    desired.current = index
    const next = collection.images[index]
    const request = ++generation.current
    setHistoryError('')
    setView({ ...next, index })
    if (next.src) return
    void Promise.resolve().then(() => gallery?.loadImage?.(next.attachment)).then(src => {
      if (typeof src !== 'string' || !src) throw new Error(t('Could not load the image.'))
      next.src = src
      if (request === generation.current) setView({ ...next, index })
    }).catch(() => { if (request === generation.current) setView({ ...next, index, error: t('Could not load the image.') }) })
  }
  const earlier = async () => {
    if (paging.current || !more.current || !gallery?.loadEarlier) return
    paging.current = true
    setLoadingEarlier(true)
    setHistoryError('')
    const request = ++generation.current
    try {
      while (more.current && request === generation.current) {
        const page = await gallery.loadEarlier()
        if (stopped.current || request !== generation.current) return
        more.current = page.hasMore === true
        setHasMore(more.current)
        const current = collection.images[desired.current]
        const merged = imageGallery([...page.items, ...collection.images], current)
        collection.images = merged.images
        desired.current = merged.index
        if (merged.index > 0) { select(merged.index - 1); return }
        setView({ ...current, index: merged.index })
      }
    } catch {
      if (!stopped.current && request === generation.current) setHistoryError(t('Could not load earlier images. Please try again.'))
    } finally {
      paging.current = false
      if (!stopped.current) setLoadingEarlier(false)
    }
  }
  const move = delta => {
    const index = desired.current + delta
    if (index < 0) { void earlier(); return }
    if (index >= collection.images.length) return
    select(index)
  }
  if (mediaOverlay) return mediaOverlay
  return h(ImagePreview, {
    src: view.src, alt: view.name, onClose, captureInput, loadError: view.error,
    editRegion: gallery?.media && (view.attachment || view.assetId || view.sourceLocator) ? () => setMediaOverlay(gallery.media.edit({ ...view, onClose: () => setMediaOverlay(null) })) : undefined,
    compare: gallery?.media && view.artifactId ? () => setMediaOverlay(gallery.media.compare({ ...view, onClose: () => setMediaOverlay(null) })) : undefined,
    navigation: collection.images.length > 1 || hasMore ? { index: view.index, total: collection.images.length, hasMore, loadingEarlier, error: historyError, previous: () => move(-1), next: () => move(1) } : null,
  })
}

export function ImagePreview({ src, alt, onClose, captureInput, navigation, loadError, editRegion, compare }) {
  const [editing, setEditing] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [color, setColor] = useState('#ff4545')
  const [width, setWidth] = useState(5)
  const [count, setCount] = useState(0)
  const [attach] = useState(() => captureInput?.() ?? null)
  const canvas = useRef(null)
  const bitmap = useRef(null)
  const strokes = useRef([])
  const active = useRef(null)
  const dialog = useRef(null)
  const opener = useRef(document.activeElement)
  const alive = useRef(true)
  const pending = useRef(false)
  const returnFocus = useRef(null)
  useEscape(() => {
    if (pending.current) return
    if (editing) { strokes.current = []; setCount(0); setEditing(false) }
    else onClose()
  })
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      bitmap.current?.close()
      bitmap.current = null
      if (returnFocus.current) returnFocus.current()
      else if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => { dialog.current?.querySelector('button:not(:disabled),input,select')?.focus({ preventScroll: true }) }, [editing])
  useEffect(() => {
    bitmap.current?.close()
    bitmap.current = null
    strokes.current = []
    setCount(0)
    setError('')
  }, [src])
  useEffect(() => {
    if (editing || !navigation) return
    const key = event => {
      if (document.querySelector('.bt-image-menu')) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target?.closest?.('input,select,textarea,[contenteditable=true],[role=menu]')) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowLeft') navigation.previous()
      else navigation.next()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [editing, navigation])
  const redraw = () => {
    const context = canvas.current?.getContext('2d')
    if (!context || !bitmap.current) return
    context.clearRect(0, 0, canvas.current.width, canvas.current.height)
    context.drawImage(bitmap.current, 0, 0)
    for (const stroke of strokes.current) paintStroke(context, stroke)
  }
  useEffect(() => {
    if (!editing) { active.current = null; setReady(false); return }
    const controller = new AbortController()
    setError('')
    const load = async () => {
      if (!bitmap.current) {
        const response = await fetch(src, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) throw new Error(t('Could not load the image.'))
        const next = await createImageBitmap(await response.blob(), { imageOrientation: 'from-image' })
        if (controller.signal.aborted) { next.close(); return }
        bitmap.current = next
      }
      if (controller.signal.aborted) return
      canvas.current.width = bitmap.current.width
      canvas.current.height = bitmap.current.height
      redraw()
      setReady(true)
    }
    void load().catch(() => { if (!controller.signal.aborted) setError(t('Could not load the image.')) })
    return () => controller.abort()
  }, [editing, src])
  const pointAt = event => {
    const box = canvas.current.getBoundingClientRect()
    return { x: Math.max(0, Math.min(canvas.current.width, (event.clientX - box.left) * canvas.current.width / box.width)), y: Math.max(0, Math.min(canvas.current.height, (event.clientY - box.top) * canvas.current.height / box.height)) }
  }
  const startStroke = event => {
    if (!ready || pending.current || event.button !== 0 || active.current) return
    event.preventDefault()
    canvas.current.setPointerCapture(event.pointerId)
    const stroke = { color, width: width * canvas.current.width / canvas.current.getBoundingClientRect().width, points: [pointAt(event)] }
    strokes.current.push(stroke)
    active.current = { id: event.pointerId, stroke }
    paintStroke(canvas.current.getContext('2d'), stroke)
    setCount(strokes.current.length)
  }
  const moveStroke = event => {
    const stroke = active.current?.id === event.pointerId ? active.current.stroke : null
    if (!stroke) return
    event.preventDefault()
    const points = [stroke.points.at(-1)]
    const samples = event.getCoalescedEvents?.()
    for (const sample of samples?.length ? samples : [event]) points.push(pointAt(sample))
    stroke.points.push(...points.slice(1))
    paintStroke(canvas.current.getContext('2d'), { ...stroke, points })
  }
  const endStroke = event => {
    if (active.current?.id !== event.pointerId) return
    if (event.type === 'pointerup') moveStroke(event)
    active.current = null
    if (canvas.current.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId)
  }
  const reset = all => {
    if (active.current) return
    if (all) strokes.current = []
    else strokes.current.pop()
    redraw()
    setCount(strokes.current.length)
  }
  const done = async () => {
    if (!ready || !attach || pending.current || active.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const blob = await new Promise((resolve, reject) => canvas.current.toBlob(value => value ? resolve(value) : reject(new Error(t('Could not export the image.'))), 'image/png'))
      if (!alive.current) return
      const name = (alt || 'image').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 140)
      returnFocus.current = attach(new File([blob], `${name}-annotated.png`, { type: 'image/png' }))
      onClose()
    } catch (failure) {
      if (alive.current) setError(failure?.message || t('Could not export the image.'))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const keyDown = event => {
    if (event.key !== 'Tab') return
    const buttons = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')]
    const first = buttons[0]
    const last = buttons.at(-1)
    if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return createPortal(h('div', { className: 'bt-image-preview', onPointerDown: event => { if (event.target === event.currentTarget && !editing && !pending.current) onClose() } },
    h('section', { ref: dialog, className: 'bt-image-preview-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t(editing ? 'Annotate image' : 'Image preview'), onKeyDown: keyDown },
      h('div', { className: 'bt-image-preview-toolbar', role: 'toolbar', 'aria-label': t('Image actions') },
        !editing && navigation ? h('div', { className: 'bt-image-preview-navigation' },
          h('button', { type: 'button', 'aria-label': t('Previous image'), title: t('Previous image'), disabled: navigation.loadingEarlier || (navigation.index === 0 && !navigation.hasMore), onClick: navigation.previous }, h(ChevronLeftIcon)),
          h('span', { className: 'bt-image-preview-counter', role: 'status', 'aria-busy': navigation.loadingEarlier || undefined, 'aria-label': t('Image {index} of {total}', { index: navigation.index + 1, total: navigation.total }) }, `${navigation.index + 1} / ${navigation.total}${navigation.hasMore ? '+' : ''}`),
          h('button', { type: 'button', 'aria-label': t('Next image'), title: t('Next image'), disabled: navigation.index === navigation.total - 1, onClick: navigation.next }, h(ChevronRightIcon))) : null,
        editing ? h('div', { className: 'bt-image-preview-tools' },
          h('label', null, t('Color'), h('input', { type: 'color', value: color, 'aria-label': t('Brush color'), disabled: busy, onChange: event => setColor(event.target.value) })),
          h('label', null, t('Brush size'), h('select', { value: width, 'aria-label': t('Brush size'), disabled: busy, onChange: event => setWidth(Number(event.target.value)) }, ...[2, 5, 10, 18].map(value => h('option', { key: value, value }, `${value}px`)))),
          h('button', { type: 'button', disabled: !count || busy, onClick: () => reset(false) }, h(ReplyIcon), t('Undo')),
          h('button', { type: 'button', disabled: !count || busy, onClick: () => reset(true) }, h(TrashIcon), t('Clear')),
          h('button', { type: 'button', disabled: busy, onClick: () => { strokes.current = []; setCount(0); setEditing(false) } }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-image-preview-done', disabled: !ready || busy, onClick: () => void done() }, h(CheckIcon), t(busy ? 'Adding…' : 'Done')))
          : h('button', { type: 'button', disabled: !attach || !src || Boolean(loadError) || navigation?.loadingEarlier, onClick: () => setEditing(true) }, h(PencilIcon), t('Annotate image')),
        !editing && editRegion ? h('button', { type: 'button', disabled: !src || Boolean(loadError), onClick: editRegion }, t('Edit region')) : null,
        !editing && compare ? h('button', { type: 'button', onClick: compare }, t('Compare result')) : null,
        h('button', { type: 'button', disabled: busy, 'aria-label': t('Close'), onClick: onClose }, h(CloseIcon))),
      h('div', { className: 'bt-image-preview-stage' }, editing
        ? h('canvas', { ref: canvas, className: 'bt-image-preview-media', 'aria-label': t('Drawing canvas'), 'data-image-name': alt, 'data-ready': ready ? '' : undefined, onPointerDown: startStroke, onPointerMove: moveStroke, onPointerUp: endStroke, onPointerCancel: endStroke, onLostPointerCapture: endStroke })
        : loadError ? h('span', { role: 'alert' }, loadError) : src ? h('img', { className: 'bt-image-preview-media', src, alt, draggable: false }) : h('span', { role: 'status' }, t('Loading image…'))),
      error || navigation?.error ? h('div', { className: 'bt-image-preview-error', role: 'alert' }, error || navigation.error) : navigation?.loadingEarlier ? h('div', { className: 'bt-image-preview-hint', role: 'status' }, t('Loading earlier images…')) : editing && !ready ? h('div', { className: 'bt-image-preview-hint', role: 'status' }, t('Loading image…')) : null)), document.body)
}

export const IMAGE_PREVIEW_CSS = `
.bt-image-preview{position:fixed;inset:var(--dsh-frame-chrome-top,40px) 0 0;z-index:200;display:flex;padding:12px;background:rgba(0,0,0,.88);color:#f2f2f2}
.bt-image-preview-dialog{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;gap:12px;pointer-events:none}
.bt-image-preview-toolbar{order:2;display:flex;flex:none;align-self:center;align-items:center;justify-content:center;gap:4px;width:max-content;max-width:100%;box-sizing:border-box;pointer-events:auto;min-height:40px;padding:6px;border-radius:16px;background:var(--bt-bubble);color:var(--bt-ink);box-shadow:0 6px 24px rgba(0,0,0,.24);flex-wrap:wrap}
.bt-image-preview-tools{display:contents}
.bt-image-preview-navigation{display:flex;align-items:center;gap:2px;padding-right:4px;margin-right:2px;border-right:1px solid var(--bt-line-2)}
.bt-image-preview-navigation svg{width:16px;height:16px}
.bt-image-preview-counter{min-width:46px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums;color:var(--bt-ink-2)}
.bt-image-preview-toolbar button,.bt-image-preview-toolbar label{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;box-sizing:border-box;font:inherit;font-size:13px;color:inherit;white-space:nowrap}
.bt-image-preview-toolbar button{padding:4px 10px;border:0;border-radius:8px;background:transparent;cursor:pointer;outline:none}
.bt-image-preview-toolbar button:focus-visible{outline:1px solid var(--bt-line-2);outline-offset:1px}
.bt-image-preview-toolbar button:hover{background:var(--bt-hover)}
.bt-image-preview-toolbar button:disabled{opacity:.45;cursor:default}
.bt-image-preview-toolbar .bt-image-preview-done{background:var(--bt-hover)}
.bt-image-preview-toolbar input[type=color]{width:28px;height:28px;padding:2px;border:0;background:none;cursor:pointer}
.bt-image-preview-toolbar select{max-width:75px;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:6px;padding:4px}
.bt-image-preview-stage{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;min-width:0;overflow:hidden;pointer-events:none}
.bt-image-preview-media{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;pointer-events:auto;border-radius:6px}
canvas.bt-image-preview-media{touch-action:none;cursor:crosshair;border-radius:0}
.bt-image-preview-error,.bt-image-preview-hint{order:1;text-align:center;font-size:13px;line-height:20px;pointer-events:auto}
.bt-image-preview-error{color:#ff8d8d}
`
