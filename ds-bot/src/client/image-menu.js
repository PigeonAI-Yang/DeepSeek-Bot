import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageGallery } from './image-preview.js'
import { CopyIcon, DownloadIcon, SearchIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

const imageSuffix = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }

function imageInfo(src, label) {
  if (!src) return null
  const url = new URL(src, document.baseURI)
  if (!['http:', 'https:', 'blob:', 'data:', 'dsh-app:'].includes(url.protocol)) return null
  const path = url.searchParams.get('path') ?? url.pathname
  const leaf = path.split(/[\\/]/).at(-1) ?? ''
  let name = imageSuffix.test(label) ? label : imageSuffix.test(leaf) ? leaf : 'image'
  try { name = decodeURIComponent(name) } catch { /* use the undecoded filename */ }
  name = name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 160)
  return { src, name }
}

export function chatImage(target) {
  const image = target instanceof Element ? target.closest('img') : null
  if (!image?.closest('[data-conversation-scroll]') || !image.closest('[data-chat-flow-kind]') || image.closest('.bt-mark,.bt-umention')) return null
  return image.complete && image.naturalWidth ? imageInfo(image.currentSrc || image.src, image.alt) : null
}

function previewImage(target) {
  const image = target instanceof Element ? target.closest('.bt-image-preview-media') : null
  if (!image?.closest('.bt-image-preview')) return null
  if (image instanceof HTMLImageElement) return image.complete && image.naturalWidth ? imageInfo(image.currentSrc || image.src, image.alt) : null
  if (image instanceof HTMLCanvasElement && image.hasAttribute('data-ready')) {
    const name = (image.dataset.imageName || 'image').replace(/\.[^.]+$/, '')
    return imageInfo(image.toDataURL('image/png'), `${name}-annotated.png`)
  }
  return null
}

async function imageBlob(src, signal) {
  const response = await fetch(src, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(t('Could not load the image.'))
  return response.blob()
}

async function pngBlob(blob) {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(t('Could not copy the image.'))
    context.drawImage(bitmap, 0, 0)
    return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(t('Could not copy the image.'))), 'image/png'))
  } finally { bitmap.close() }
}

export function copyChatImage(image, signal) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.reject(new Error(t('Image copying is unavailable in this window.')))
  const png = imageBlob(image.src, signal).then(pngBlob)
  png.catch(() => {})
  // Hand the promise to ClipboardItem before awaiting to retain the click's activation.
  const item = new ClipboardItem({ 'image/png': png })
  return navigator.clipboard.write([item])
}

export async function saveChatImage(image, signal) {
  const picker = typeof window.showSaveFilePicker === 'function'
    ? window.showSaveFilePicker({ suggestedName: image.name === 'image' ? 'image.png' : image.name }) : null
  const handle = picker ? await picker : null
  let blob = await imageBlob(image.src, signal)
  if (handle) {
    if (/\.png$/i.test(handle.name) && blob.type !== 'image/png') blob = await pngBlob(blob)
    const writable = await handle.createWritable()
    try { await writable.write(blob); await writable.close() } catch (error) { await writable.abort().catch(() => {}); throw error }
    return
  }
  const filename = imageSuffix.test(image.name) ? image.name : `${image.name}.${extensions[blob.type] ?? 'png'}`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ImageMenu({ image, onClose, onPreview }) {
  const ref = useRef(null)
  const opener = useRef(image.opener ?? document.activeElement)
  const abort = useRef(null)
  const [place, setPlace] = useState({ left: image.x, top: image.y })
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useEscape(onClose)
  useEffect(() => {
    const closeOutside = event => { if (!ref.current?.contains(event.target)) onClose() }
    const close = () => onClose()
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      abort.current?.abort()
      if (opener.current instanceof HTMLElement && opener.current.isConnected && (document.activeElement === document.body || ref.current?.contains(document.activeElement))) opener.current.focus({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => {
    const menu = ref.current
    if (menu) setPlace({ left: Math.max(8, Math.min(image.x, innerWidth - menu.offsetWidth - 8)), top: Math.max(8, Math.min(image.y, innerHeight - menu.offsetHeight - 8)) })
  }, [image.x, image.y, error])
  useEffect(() => { ref.current?.querySelector('button')?.focus({ preventScroll: true }) }, [])
  const run = async operation => {
    if (pending) return
    const controller = new AbortController()
    abort.current = controller
    setPending(true)
    setError('')
    try {
      await operation(controller.signal)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure?.name === 'AbortError') { onClose(); return }
      setError(t('The image action failed. Please try again.'))
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  const copy = signal => copyChatImage(image, signal).then(() => { if (!signal.aborted) setCopied(true) })
  const save = signal => saveChatImage(image, signal).then(() => { if (!signal.aborted) onClose() })
  const keyDown = event => {
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]
    const current = buttons.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : -1
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
  }
  return h('div', { ref, className: 'bt-menu bt-image-menu', role: 'menu', 'aria-label': t('Image actions'), style: place, onKeyDown: keyDown },
    h('button', { type: 'button', role: 'menuitem', disabled: pending, onClick: () => void run(copy) }, h(CopyIcon), copied ? t('Image copied') : t('Copy image')),
    h('button', { type: 'button', role: 'menuitem', disabled: pending, onClick: () => void run(save) }, h(DownloadIcon), t('Save image as…')),
    image.expanded ? null : h('button', { type: 'button', role: 'menuitem', disabled: pending, onClick: () => { onClose(); onPreview(image) } }, h(SearchIcon), t('View full image')),
    error ? h('div', { className: 'bt-image-menu-error', role: 'alert' }, error) : null)
}

export function ImageContextMenu({ actions }) {
  const [image, setImage] = useState(null)
  const [preview, setPreview] = useState(null)
  const serial = useRef(0)
  const showPreview = target => {
    const rendered = [...document.querySelectorAll('[data-conversation-scroll] [data-chat-flow-kind] img')].map(chatImage).filter(Boolean)
    setPreview({ ...target, gallery: actions?.imageGallery?.(), rendered, attach: actions?.captureImageInput?.() })
  }
  useEffect(() => {
    const open = event => {
      const enlarged = previewImage(event.target)
      const target = enlarged ?? chatImage(event.target)
      if (!target) { setImage(null); return }
      event.preventDefault()
      event.stopPropagation()
      const opener = enlarged ? event.target.closest('.bt-image-preview')?.querySelector('.bt-image-preview-toolbar button:not(:disabled)') : document.activeElement
      setImage({ ...target, opener, expanded: Boolean(enlarged), x: event.clientX, y: event.clientY, key: ++serial.current })
    }
    const click = event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const target = chatImage(event.target)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      setImage(null)
      showPreview(target)
    }
    document.addEventListener('contextmenu', open, true)
    document.addEventListener('click', click, true)
    return () => {
      document.removeEventListener('contextmenu', open, true)
      document.removeEventListener('click', click, true)
    }
  }, [])
  return createPortal(h('div', { className: 'bt-image-menu-layer' },
    image ? h(ImageMenu, { key: image.key, image, onClose: () => setImage(null), onPreview: showPreview }) : null,
    preview ? h(ImageGallery, { image: preview, gallery: preview.gallery, rendered: preview.rendered, captureInput: () => preview.attach, onClose: () => setPreview(null) }) : null), document.body)
}

export const IMAGE_MENU_CSS = `
.bt-image-menu{z-index:210;max-width:280px}
.bt-image-menu button:focus-visible{background:var(--bt-hover);outline:1px solid var(--bt-line-2);outline-offset:-1px}
.bt-image-menu button:disabled{opacity:.5;cursor:wait}
.bt-image-menu-error{padding:6px 8px;color:var(--bt-ink-3);font-size:12px;line-height:18px}
`
