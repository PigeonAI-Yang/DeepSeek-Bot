import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery } from './image-preview.js'
import { ArrowDownIcon, FolderIcon } from './icons.js'
import { t } from './i18n.js'
import { SPRING_SHAPE, SPRING_STRETCH, useLinger, useSurfaceMorph } from './motion.js'

const CARD_WIDTH = 280
const CARD_GUTTER = 16
const CHAT_WIDTH = 736
const FIT_SAFETY = 24
const FIT_RIGHT_SPACE = CARD_WIDTH + CARD_GUTTER + FIT_SAFETY
const MIN_SCROLLER_WIDTH = CHAT_WIDTH + 2 * FIT_RIGHT_SPACE

function PhotoPlaceholder() {
  return h('svg', {
    className: 'bt-outputs-photo', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  },
  h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
  h('circle', { cx: 8.5, cy: 9, r: 1.5 }),
  h('path', { d: 'm21 15-5-5L5 20' }))
}

function OutputRow({ sessionId, item, actions, onPreview, onHover, onLeave }) {
  const [thumbnail, setThumbnail] = useState(null)
  const loadImageRef = useRef(actions.loadOutputImage)
  loadImageRef.current = actions.loadOutputImage
  const loadMediaRef = useRef(actions.loadMediaImage)
  loadMediaRef.current = actions.loadMediaImage

  useEffect(() => {
    let current = true
    setThumbnail(null)
    if (item.kind === 'image' && item.attachment && typeof loadImageRef.current === 'function') {
      Promise.resolve()
        .then(() => item.artifactId && loadMediaRef.current ? loadMediaRef.current(item) : loadImageRef.current(item.attachment))
        .then(src => { if (current && typeof src === 'string' && src !== '') setThumbnail(src) })
        .catch(() => {})
    }
    return () => { current = false }
  }, [sessionId, item.key, item.attachment])

  const open = () => {
    if (item.kind === 'image' && thumbnail) {
      onPreview({ ...item, src: thumbnail })
      return
    }
    if (item.path) void Promise.resolve(actions.openOutputFile(item.path)).catch(() => {})
  }
  const icon = thumbnail
    ? h('img', { className: 'bt-outputs-thumb', src: thumbnail, alt: '', loading: 'lazy' })
    : item.kind === 'image'
      ? h(PhotoPlaceholder)
      : ui.FileTypeIcon ? h(ui.FileTypeIcon, { path: item.name, className: 'bt-outputs-icon' }) : h('span', { className: 'bt-outputs-file-icon', 'aria-hidden': true })
  const clickable = Boolean(thumbnail || item.path)
  return h('button', {
    type: 'button', className: 'bt-outputs-row', disabled: !clickable,
    title: item.kind === 'image' ? undefined : item.name, 'aria-label': item.name, onClick: open,
    onPointerEnter: event => {
      if (!thumbnail || event.pointerType === 'touch') return
      const rect = event.currentTarget.getBoundingClientRect()
      const img = event.currentTarget.querySelector('img')
      onHover({ ...item, src: thumbnail, rect, width: img?.naturalWidth, height: img?.naturalHeight })
    },
    onPointerLeave: onLeave,
    onFocus: event => {
      if (thumbnail) onHover({ ...item, src: thumbnail, rect: event.currentTarget.getBoundingClientRect() }, true)
    },
    onBlur: onLeave,
  },
  h('span', { className: 'bt-outputs-row-icon' }, icon),
  h('span', { className: 'bt-outputs-row-body' },
    h('span', { className: 'bt-outputs-name' }, item.name),
    h('span', { className: 'bt-outputs-kind' }, t(item.kind === 'image' ? 'Image' : 'File'))))
}

function OutputList({ sessionId, items, actions, onPreview, onHover, onLeave }) {
  if (items.length === 0) return h('div', { className: 'bt-outputs-empty' }, t('No outputs yet'))
  return h('div', { className: 'bt-outputs-list' }, items.map(item => h(OutputRow, {
    key: item.key, sessionId, item, actions, onPreview, onHover, onLeave,
  })))
}

function panelOverlapsCard(top, right) {
  const cardRight = window.innerWidth - right
  const cardLeft = cardRight - CARD_WIDTH
  return [...document.querySelectorAll('.bt-panel, .bt-pane')].some(panel => {
    const style = getComputedStyle(panel)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = panel.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left < cardRight && rect.right > cardLeft && rect.top < window.innerHeight && rect.bottom > top
  })
}

function useOutputPlacement() {
  const [placement, setPlacement] = useState({ ready: false, fits: false, blocked: false, top: 60, right: CARD_GUTTER, maxHeight: 420 })
  const previousFit = useRef(null)
  const setManualOpen = useRef(null)

  useLayoutEffect(() => {
    let frame = 0
    let observed = null
    let observer
    const measure = () => {
      frame = 0
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller !== observed) {
        observer?.disconnect()
        observed = scroller
        if (observed && observer) observer.observe(observed)
      }
      const scrollerRect = scroller?.getBoundingClientRect()
      const chromeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-chrome-top')) || 0
      const top = Math.max(chromeTop, scrollerRect?.top ?? chromeTop) + CARD_GUTTER
      const right = Math.max(CARD_GUTTER, window.innerWidth - (scrollerRect?.right ?? window.innerWidth) + CARD_GUTTER)
      const maxHeight = Math.max(0, Math.min(420, window.innerHeight - top - 24))

      let contentRect = null
      const contentTrack = scroller?.querySelector('[data-chat-flow-kind]')
      if (contentTrack) contentRect = contentTrack.getBoundingClientRect()
      if (!contentRect && scrollerRect) {
        const scrollStyle = getComputedStyle(scroller)
        const inlineSpace = (parseFloat(scrollStyle.paddingLeft) || 0) + (parseFloat(scrollStyle.paddingRight) || 0)
        const innerWidth = Math.max(0, scrollerRect.width - inlineSpace)
        const width = Math.min(CHAT_WIDTH, innerWidth)
        const left = scrollerRect.left + (scrollerRect.width - width) / 2
        contentRect = { left, right: left + width, width }
      }
      const rightSpace = contentRect && scrollerRect ? scrollerRect.right - contentRect.right : 0
      const fits = Boolean(scrollerRect && contentRect && contentRect.width >= CHAT_WIDTH && scrollerRect.width >= MIN_SCROLLER_WIDTH && rightSpace >= FIT_RIGHT_SPACE)
      const blocked = panelOverlapsCard(top, right)
      if (previousFit.current !== null && previousFit.current !== fits) setManualOpen.current?.(null)
      if (blocked) setManualOpen.current?.(null)
      previousFit.current = fits
      setPlacement(previous => {
        const next = { ready: true, fits, blocked, top, right, maxHeight }
        return Object.keys(next).every(key => previous[key] === next[key]) ? previous : next
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    if (typeof ResizeObserver === 'function') observer = new ResizeObserver(schedule)
    const mutation = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null
    if (mutation && document.body) mutation.observe(document.body, { childList: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      mutation?.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [])
  return { placement, setManualOpen }
}

export function OutputsCard({ sessionId, useOutputs, useSession, actions, dock, surfaceRef, embedded = false, manual: givenManual, setManual: givenSetManual, onHoverEnd, onPreviewChange }) {
  const items = useOutputs(value => value)
  const hasMore = useSession(snapshot => snapshot?.hasMore === true)
  const { placement, setManualOpen } = useOutputPlacement()
  const [ownManual, ownSetManual] = useState(null)
  const manual = givenManual === undefined ? ownManual : givenManual
  const setManual = givenSetManual ?? ownSetManual
  const [preview, setPreview] = useState(null)
  const [hover, setHover] = useState(null)
  const [cardHovered, setCardHovered] = useState(false)
  const hoverTimer = useRef(null)
  const cardHoverTimer = useRef(null)
  const hoverSuppressed = useRef(false)
  const previewChange = useRef(onPreviewChange)
  previewChange.current = onPreviewChange
  const card = useRef(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const previewGeneration = useRef(0)
  const loadingEarlierRef = useRef(false)
  setManualOpen.current = setManual

  const open = embedded || (manual ?? (placement.ready && placement.fits)) || (cardHovered && !dock?.dragging) || preview !== null
  const visible = embedded || (open && placement.maxHeight > 0 && !placement.blocked)
  const [mounted] = useLinger(visible, SPRING_SHAPE.duration)
  useSurfaceMorph(card, `${sessionId}:${visible}:${items.length}:${hasMore}:${loadingEarlier}`, visible)
  useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(cardHoverTimer.current); previewChange.current?.(false) }, [])
  useEffect(() => { clearTimeout(hoverTimer.current); setHover(null) }, [sessionId, visible])
  const keepHover = () => { clearTimeout(hoverTimer.current); clearTimeout(cardHoverTimer.current) }
  const enterCardHover = event => {
    clearTimeout(cardHoverTimer.current)
    if (event.pointerType !== 'touch' && !dock?.dragging && !hoverSuppressed.current) setCardHovered(true)
  }
  const leaveCardHover = () => {
    clearTimeout(cardHoverTimer.current)
    hoverSuppressed.current = false
    cardHoverTimer.current = setTimeout(() => setCardHovered(false), 160)
  }
  const leaveHover = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => { setHover(null); onHoverEnd?.() }, 160)
  }
  const showHover = (value, immediate = false) => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(value), immediate ? 0 : 130)
  }
  const toggle = () => {
    const next = !(manual ?? (placement.ready && placement.fits))
    setManual(next)
    if (!next) {
      clearTimeout(cardHoverTimer.current)
      hoverSuppressed.current = true
      setCardHovered(false)
    }
  }
  const loadEarlier = async () => {
    if (loadingEarlierRef.current || !hasMore || typeof actions.loadEarlierOutputs !== 'function') return
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    try { await actions.loadEarlierOutputs() } catch { return } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }
  const showPreview = value => {
    clearTimeout(hoverTimer.current)
    clearTimeout(cardHoverTimer.current)
    setCardHovered(false)
    setHover(null)
    previewChange.current?.(true)
    const generation = ++previewGeneration.current
    setPreview({ ...value, generation, gallery: actions.imageGallery?.(sessionId) })
  }
  const closePreview = () => {
    previewGeneration.current += 1
    setPreview(null)
    previewChange.current?.(false)
  }
  if (typeof document === 'undefined') return null

  const style = {
    '--bt-outputs-top': `${placement.top}px`,
    '--bt-outputs-right': `${placement.right}px`,
    '--bt-outputs-max-height': `${placement.maxHeight}px`,
    '--bt-surface-duration': `${visible ? SPRING_STRETCH.duration : SPRING_SHAPE.duration}ms`,
    '--bt-surface-easing': visible ? SPRING_STRETCH.easing : SPRING_SHAPE.easing,
    ...dock?.styleFor('outputs'),
  }
  const toggleButton = h('button', {
    type: 'button', className: 'bt-outputs-toggle',
    'aria-expanded': visible,
    'aria-label': t('Outputs ({count})', { count: items.length }),
    title: t('Outputs ({count})', { count: items.length }),
    disabled: placement.blocked,
    onClick: () => { if (!dock?.consumeClick()) toggle() },
    ...dock?.dragProps('outputs'),
  },
  h('span', { className: 'bt-outputs-label-icon', 'aria-hidden': true }, h(FolderIcon)),
  h('span', { className: 'bt-outputs-count', 'aria-hidden': true }, String(items.length)),
  h('span', { className: 'bt-outputs-caret', 'data-open': visible ? '' : undefined, 'aria-hidden': true }, h(ArrowDownIcon)))

  const body = (mounted || embedded) ? h('div', { className: 'bt-outputs-body', 'data-open': visible ? '' : undefined, inert: visible ? undefined : '' },
      actions.mediaJobs?.(),
      h(OutputList, { sessionId, items, actions, onPreview: showPreview, onHover: showHover, onLeave: leaveHover }),
      hasMore ? h('button', {
        type: 'button', className: 'bt-outputs-earlier', disabled: loadingEarlier,
        onClick: loadEarlier,
      }, loadingEarlier ? t('Loading…') : t('Load earlier outputs')) : null) : null
  const ratio = hover?.width > 0 && hover?.height > 0 ? hover.width / hover.height : 1
  const hoverHeight = Math.min(648, innerHeight - 64, 480 / ratio)
  const hoverWidth = Math.min(innerWidth - 32, hoverHeight * ratio)
  const hoverLeft = hover ? Math.max(16, hover.rect.left >= hoverWidth + 28 ? hover.rect.left - hoverWidth - 12 : innerWidth - hoverWidth - 16) : 16
  const hoverTop = hover ? Math.max(48, Math.min(hover.rect.top, innerHeight - hoverHeight - 44)) : 48
  const overlays = h('div', { className: 'bt-outputs-layer' },
    hover && visible ? h('button', {
      type: 'button', className: 'bt-output-hover', role: 'tooltip', 'aria-label': hover.name,
      style: { left: hoverLeft, top: hoverTop, width: hoverWidth },
      onPointerEnter: keepHover, onPointerLeave: () => { leaveHover(); leaveCardHover() }, onFocus: keepHover, onBlur: leaveHover,
      onClick: () => showPreview(hover), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setHover(null) } },
    }, h('img', { src: hover.src, alt: hover.name, style: { maxHeight: hoverHeight } }), h('span', null, hover.name)) : null,
    preview && visible ? h(ImageGallery, {
      image: preview,
      gallery: preview.gallery,
      captureInput: () => actions.captureImageInput?.(sessionId),
      onClose: closePreview,
      key: `${sessionId}:${preview.generation}`,
    }) : null)
  if (embedded) return h('section', { className: 'bt-outputs-embedded', 'aria-label': t('Outputs') },
    h('div', { className: 'bt-outputs-embedded-title' }, t('Outputs'), ` · ${items.length}`), body, createPortal(overlays, document.body))
  return createPortal(h('div', { className: 'bt-outputs-layer' },
    h('section', {
      ref: node => { card.current = node; if (surfaceRef) surfaceRef.current = node },
      className: 'bt-outputs-card', 'data-expanded': visible ? '' : undefined, style,
      onPointerEnter: enterCardHover, onPointerLeave: leaveCardHover,
      role: 'region', 'aria-label': t('Outputs'), ...dock?.attrsFor('outputs'),
    }, toggleButton, body), overlays), document.body)
}
