import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { currentPart, latestMemoryChange } from './text.js'
import { ArrowUpIcon, CloseIcon, ArrowDownIcon, MemoryIcon, FolderIcon } from './icons.js'
import { botState, BotAvatar, RoomAvatar } from './mark.js'
import { ActivityIndicator } from './activity-row.js'
import { clockLabel, openingTurn, unseenSince, Shimmer, recordActivity } from './cells.js'
import { modelOf } from './model-menu.js'
import { NO_WORK, busyMembers, summaryText } from './member-status.js'
import { viewBottom } from './motion.js'
import { t } from './i18n.js'
import { SPRING_SHAPE, SPRING_STRETCH, reducedMotion } from './motion.js'
import { OutputsCard } from './outputs-card.js'
import { useCapsuleDock } from './capsule-dock.js'

// -------------------------------------------------------------------------
// Conversation header

// The pill's tail: a → that springs in on hover, flipping to ← while details are open.
const GoArrow = () => h('svg', { width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

// How long the pill says "Memory updated" after the change reaches this window.
const MEMORY_NOTICE_MS = 3_200
const RUNTIME_PANEL_EXIT_MS = SPRING_SHAPE.duration
const noNews = select => select({})
const noOutputs = select => select([])
const emptyTools = { active: [], background: [], runs: new Map() }
const noTools = select => select(emptyTools)

// True while the latest memory change of the Bots in this conversation is news.
function useMemoryNotice(ids, useMemoryNews) {
  const seen = useMemoryNews(map => Math.max(0, ...ids.map(id => map?.[id]?.seen ?? 0)))
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const left = seen + MEMORY_NOTICE_MS - Date.now()
    setShown(seen > 0 && left > 0)
    if (seen === 0 || left <= 0) return undefined
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [seen])
  return shown
}

// The notice the pill stretches to show. Its width is measured, so the pill's spring
// runs between two real widths.
function MemoryNotice({ shown }) {
  const inner = useRef(null)
  const [width, setWidth] = useState(0)
  const label = t('Memory updated')
  useLayoutEffect(() => { if (shown) setWidth(inner.current?.scrollWidth ?? 0) }, [label, shown])
  return h('span', { className: 'bt-pill-mem', 'aria-hidden': true, style: { '--bt-mem-w': `${width}px` } },
    h('span', { className: 'bt-pill-mem-in', ref: inner }, h('span', { className: 'bt-pill-mem-ico' }, h(MemoryIcon)), label))
}

function backgroundSummary(job) {
  if (job.name !== 'image-edit') return `${job.key} · ${t(job.status === 'stopping' ? 'Stopping' : 'Running')}`
  const phases = { validating:'Validating image',uploading:'Uploading image',submitting:'Submitting image',queued:'Image queued',running:'Running', 'loading-model':'Loading image model',encoding:'Encoding image',sampling:'Sampling image',decoding:'Decoding image',saving:'Saving image',collecting:'Collecting image',cancel_requested:'Stopping',connection_lost:'Image connection lost',submission_unknown:'Image submission unknown' }
  const phase = job.progress?.split(' · ')[0]
  const steps = job.progress?.match(/\b\d+\/\d+(?= steps\b)/)?.[0]
  const percent = job.progress?.match(/\b\d+%/)?.[0]
  return [t(job.label?.startsWith('Image generation') ? 'Image generation' : 'Image edit'),
    `${t(job.status === 'stopping' ? 'Stopping' : phases[phase] ?? 'Running')}${steps ? ` ${steps}` : ''}`,percent,
    job.progress?.endsWith('last observation') ? t('Last image observation') : undefined].filter(Boolean).join(' · ')
}

function RuntimeStatusPanel({ sessionId, bot, roster, running, useLive, useToolState, panelId, style, expanded, memberStatus = '', children }) {
  const liveKey = useLive(state => JSON.stringify(state[sessionId] ?? {}))
  const entries = useMemo(() => Object.entries(JSON.parse(liveKey)), [liveKey])
  const active = useToolState(value => value.active)
  const background = useToolState(value => value.background) ?? active.filter(record => record.background)
  const peer = useToolState(value => value.peer)
  const peerName = peer ? roster.byId[peer.id]?.name ?? peer.name ?? t('another Bot') : undefined
  const tools = active.length ? active.map(record => [record.key, recordActivity(record, roster, { compact: true })]) : entries.filter(([, entry]) => !entry?.text).map(([id, entry]) => [id, { ...entry, label: t(entry?.relay ? 'Coordinating with Bots' : 'Using tools') }])
  const hasQuestion = roster.questions?.[bot ? currentPart(bot) : sessionId] !== undefined
  const status = memberStatus || (hasQuestion ? t('Waiting for your answer') : !running && active.length === 0
    ? hasQuestion ? t('Waiting for your answer') : t('Idle')
    : entries.some(([, entry]) => entry?.text) ? t('Generating a response')
      : entries.some(([, entry]) => entry?.relay) ? t('Coordinating with Bots')
        : tools.length > 0 ? tools.at(-1)[1].label : peer ? t('Replying to {name}', { name: peerName }) : t('Waiting for model response'))
  const model = bot ? modelOf(bot, roster) : undefined
  const services = bot ? roster.residentServices?.[bot.id] ?? [] : []
  return h('div', {
    id: panelId, className: 'bt-runtime-popover', role: 'region', 'aria-label': t('Runtime details'),
    'data-runtime-expanded': expanded ? '' : undefined, 'aria-hidden': expanded ? undefined : true,
    inert: expanded ? undefined : '', tabIndex: expanded ? 0 : -1, style,
  },
    h('div', { className: 'bt-runtime-card' },
      h('div', { className: 'bt-runtime-content' },
        h('div', { className: 'bt-runtime-title' }, t('Runtime details')),
        h('div', { className: 'bt-runtime-row' },
          h('div', { className: 'bt-runtime-label' }, t('Current status')),
          h('div', { className: 'bt-runtime-value' }, status)),
        model ? h('div', { className: 'bt-runtime-row' },
          h('div', { className: 'bt-runtime-label' }, t('Current model')),
          h('div', { className: 'bt-runtime-value' }, model.name)) : null,
        h('div', { className: 'bt-runtime-row' },
          h('div', { className: 'bt-runtime-label' }, t('Background tasks')),
          h('div', { className: 'bt-runtime-value' }, background.length
            ? background.map(job => h('div', { key: job.key, title:job.object || job.key }, backgroundSummary(job)))
            : t('None'))),
        services.length > 0 ? h('div', { className: 'bt-runtime-row' },
          h('div', { className: 'bt-runtime-label' }, t('Resident services')),
          h('div', { className: 'bt-runtime-value' }, services.map(service => h('div', { key: service.id }, `${service.name} · ${t('Online')}`)))) : null,
        children)))
}

function measureRuntimeContentWidth(wrapper) {
  const pill = wrapper.querySelector(':scope > .bt-pill')
  const popover = wrapper.querySelector(':scope > .bt-runtime-popover')
  const card = popover?.querySelector(':scope > .bt-runtime-card')
  const content = card?.querySelector(':scope > .bt-runtime-content')
  if (!pill || !popover || !card || !content) return null
  const temporary = [
    [pill.style, 'width', 'max-content'],
    [pill.style, 'max-width', 'none'],
    [pill.style, 'flex', 'none'],
    [popover.style, 'width', 'max-content'],
    [popover.style, 'max-width', 'none'],
    [card.style, 'width', 'max-content'],
    [card.style, 'max-width', 'none'],
    [content.style, 'width', 'max-content'],
    [content.style, 'max-width', 'none'],
  ]
  const previous = temporary.map(([style, property]) => [style, property, style.getPropertyValue(property), style.getPropertyPriority(property)])
  try {
    for (const [style, property, value] of temporary) style.setProperty(property, value)
    return Math.ceil(Math.max(pill.getBoundingClientRect().width, popover.getBoundingClientRect().width))
  } finally {
    for (const [style, property, value, priority] of previous) {
      if (value) style.setProperty(property, value, priority)
      else style.removeProperty(property)
    }
  }
}

function commitRuntimeContentWidth(wrapper) {
  const card = wrapper.querySelector(':scope > .bt-runtime-popover > .bt-runtime-card')
  if (!card) return
  const style = getComputedStyle(card)
  const width = Math.max(0, card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
  const value = `${width}px`
  if (wrapper.style.getPropertyValue('--bt-runtime-content-width') !== value) {
    wrapper.style.setProperty('--bt-runtime-content-width', value)
  }
}

export function HeaderPill({ sessionId, useRoster, useSessions, useSessionStatus, useSession, useActivity, useMemoryNews, useTurnClock, useUi, useLive, useToolState = noTools, useWork, useOutputs = noOutputs, useStore, useConversationViews, selectView, actions }) {
  const roster = useRoster(value => value)
  const work = useWork?.(value => value) ?? NO_WORK
  const selectedView = useStore?.(state => state.view)
  const away = useConversationViews?.(views => views.some(view => view.id === selectedView && view.id !== 'chat')) === true
    && typeof selectView === 'function'
  const title = useSessions(list => list.byId[sessionId]?.displayTitle ?? list.byId[sessionId]?.title ?? '')
  const firstTurns = useSessions(list => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.slice(0, 8).map(entry => entry.turn).join(',') : ''
  })
  const hiddenTurns = roster.exchangeTurns?.[sessionId]
  const visit = useUi(state => state.visits?.[sessionId])
  const opening = useTurnClock(state => {
    const first = openingTurn(state[sessionId], firstTurns, hiddenTurns)
    return first && !unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  useEffect(() => {
    if (opening) document.body.style.setProperty('--bt-first-sep', JSON.stringify(opening))
    else document.body.style.removeProperty('--bt-first-sep')
    return () => document.body.style.removeProperty('--bt-first-sep')
  }, [opening])
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const owner = roster.byId[sessionId]?.id ?? sessionId
  const doing = useActivity(map => map[owner])
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const busy = room ? busyMembers(room, work, roster) : []
  const memberSummary = busy.length ? summaryText(busy) : null
  const memberStatus = memberSummary ? [memberSummary.waiting, memberSummary.doing].filter(Boolean).join(' · ') : ''
  const detailsOpen = useUi(state => state.details === sessionId)
  const name = bot?.name ?? room?.name ?? ''
  const useNews = useMemoryNews ?? noNews
  const memoryIds = bot ? [bot.id] : room ? [room.id, ...room.members] : []
  const notice = useMemoryNotice(memoryIds, useNews)
  // While the notice shows, the pill opens the memory that changed: a Bot's, or the group's.
  const changed = useNews(map => latestMemoryChange(map, memoryIds))
  useEffect(() => {
    document.body.style.setProperty('--bt-placeholder', JSON.stringify(name ? t('Message {name}', { name }) : t('Message')))
  }, [name, t('Message')])
  // The unread label under a pending steering bubble reads its text from here.
  useEffect(() => {
    document.body.style.setProperty('--bt-steer-unread', JSON.stringify(t('Not read yet')))
  }, [t('Not read yet')])
  useEffect(() => {
    actions.beginVisit(sessionId)
    return () => actions.endVisit(sessionId)
  }, [sessionId])
  useEffect(() => {
    if (room) document.body.dataset.btRoom = ''
    else delete document.body.dataset.btRoom
    return () => { delete document.body.dataset.btRoom }
  }, [Boolean(room)])
  const memoryNotice = !away && notice && changed !== null && roster.memory !== false
  const hoverWrap = useRef(null)
  const hoverCloseTimer = useRef(null)
  const imagePreviewOpen = useRef(false)
  const outputsRef = useRef(null)
  const hasOutputs = useOutputs !== noOutputs
  const outputCount = useOutputs(value => value.length)
  const [outputsManual, setOutputsManual] = useState(null)
  const runtimeWidth = useRef({ sessionId: null, expanded: null, width: null, contentWidth: null, animation: null })
  const panelId = useId()
  const [openForSession, setOpenForSession] = useState(null)
  const [panelStyle, setPanelStyle] = useState(null)
  const [panelForSession, setPanelForSession] = useState(null)
  const [expandedForSession, setExpandedForSession] = useState(null)
  const dock = useCapsuleDock({ sessionId, runtimeRef: hoverWrap, outputsRef,
    onMerge: () => setOpenForSession(sessionId),
    onSplit: () => { setOpenForSession(null); setOutputsManual(false) },
  })
  const open = openForSession === sessionId
  const mounted = open || panelForSession === sessionId
  const expanded = open && expandedForSession === sessionId
  useEffect(() => () => clearTimeout(hoverCloseTimer.current), [sessionId])
  const rememberRuntimeWidth = () => {
    const wrapper = hoverWrap.current
    const state = runtimeWidth.current
    if (wrapper && state.sessionId === sessionId && !state.animation) state.width = wrapper.getBoundingClientRect().width
  }
  const animateRuntimeWidth = (wrapper, from, to, state) => {
    state.width = to
    if (state.expanded) commitRuntimeContentWidth(wrapper)
    if (typeof wrapper.animate !== 'function' || Math.abs(from - to) < 1 || reducedMotion()) return
    const curve = state.expanded ? SPRING_STRETCH : SPRING_SHAPE
    const animation = wrapper.animate([
      { width: `${from}px`, minWidth: '0px', maxWidth: '100%' },
      { width: `${to}px`, minWidth: '0px', maxWidth: '100%' },
    ], { duration: curve.duration, easing: curve.easing, fill: 'none' })
    state.animation = animation
    animation.onfinish = () => {
      if (state.animation !== animation) return
      state.animation = null
      state.width = wrapper.getBoundingClientRect().width
    }
  }
  const updateRuntimeContentWidth = (wrapper, state) => {
    const width = measureRuntimeContentWidth(wrapper)
    if (width === null || (state.contentWidth !== null && Math.abs(width - state.contentWidth) < 1)) return false
    wrapper.style.setProperty('--bt-runtime-width', `${width}px`)
    state.contentWidth = width
    return true
  }
  useLayoutEffect(() => {
    const wrapper = hoverWrap.current
    if (!wrapper) return
    const state = runtimeWidth.current
    const sameSession = state.sessionId === sessionId
    if (!sameSession) state.contentWidth = null
    const expandedChanged = sameSession && state.expanded !== expanded
    const contentChanged = expanded && updateRuntimeContentWidth(wrapper, state)
    if (sameSession && !expandedChanged && !(expanded && contentChanged)) {
      if (!state.animation) state.width = wrapper.getBoundingClientRect().width
      return
    }
    const from = state.animation
      ? wrapper.getBoundingClientRect().width
      : sameSession ? state.width : null
    state.animation?.cancel()
    state.animation = null
    const to = wrapper.getBoundingClientRect().width
    state.sessionId = sessionId
    state.expanded = expanded
    state.width = to
    if (expanded) animateRuntimeWidth(wrapper, from ?? to, to, state)
    else if (sameSession && expandedChanged && from !== null) animateRuntimeWidth(wrapper, from, to, state)
  })
  useLayoutEffect(() => {
    const wrapper = hoverWrap.current
    const head = wrapper?.parentElement
    if (!head || typeof ResizeObserver !== 'function') return undefined
    let headWidth = head.getBoundingClientRect().width
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries.find(entry => entry.target === head)?.contentRect.width ?? head.getBoundingClientRect().width
      if (Math.abs(nextWidth - headWidth) < 1) return
      headWidth = nextWidth
      const state = runtimeWidth.current
      const wasAnimating = Boolean(state.animation)
      const from = wrapper.getBoundingClientRect().width
      const contentChanged = state.expanded && updateRuntimeContentWidth(wrapper, state)
      if (!wasAnimating && !contentChanged && !state.expanded) {
        state.width = wrapper.getBoundingClientRect().width
        return
      }
      state.animation?.cancel()
      state.animation = null
      const to = wrapper.getBoundingClientRect().width
      state.width = to
      if (state.expanded || wasAnimating) animateRuntimeWidth(wrapper, from, to, state)
    })
    observer.observe(head)
    return () => observer.disconnect()
  }, [sessionId])
  useLayoutEffect(() => {
    const wrapper = hoverWrap.current
    const popover = wrapper?.querySelector(':scope > .bt-runtime-popover')
    if (!expanded || !popover || typeof MutationObserver !== 'function') return undefined
    const observer = new MutationObserver(() => {
      const state = runtimeWidth.current
      if (!state.expanded || state.sessionId !== sessionId) return
      const from = wrapper.getBoundingClientRect().width
      if (!updateRuntimeContentWidth(wrapper, state)) return
      state.animation?.cancel()
      state.animation = null
      const to = wrapper.getBoundingClientRect().width
      state.width = to
      animateRuntimeWidth(wrapper, from, to, state)
    })
    observer.observe(popover, { childList: true, characterData: true, subtree: true })
    return () => observer.disconnect()
  }, [expanded, sessionId])
  useLayoutEffect(() => () => {
    const state = runtimeWidth.current
    state.animation?.cancel()
    state.animation = null
  }, [])
  useEffect(() => {
    setOpenForSession(null)
    setPanelForSession(null)
    setExpandedForSession(null)
    setPanelStyle(null)
  }, [sessionId])
  useEffect(() => {
    if (open) {
      setPanelForSession(sessionId)
      let firstFrame = null
      let secondFrame = null
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = null
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = null
          setExpandedForSession(sessionId)
        })
      })
      return () => {
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame)
        if (secondFrame !== null) window.cancelAnimationFrame(secondFrame)
      }
    }
    if (!mounted) return undefined
    const timer = window.setTimeout(() => {
      setPanelForSession(current => current === sessionId ? null : current)
    }, RUNTIME_PANEL_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, sessionId, mounted])
  useLayoutEffect(() => {
    if (!open) {
      setExpandedForSession(current => current === sessionId ? null : current)
      if (!mounted) setPanelStyle(null)
      return undefined
    }
    const measure = () => {
      const wrapper = hoverWrap.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const maxHeight = Math.max(0, Math.min(400, window.innerHeight - rect.bottom - 12))
      setPanelStyle({ '--bt-runtime-max-height': `${maxHeight}px` })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, mounted, sessionId])
  return h('div', { className: 'bt-head' },
    h('div', {
      className: 'bt-pill-hover', 'data-runtime-open': mounted ? '' : undefined, ref: hoverWrap,
      'data-runtime-expanded': expanded ? '' : undefined, 'data-dock-merged': dock.merged ? '' : undefined,
      ...dock.attrsFor('runtime'),
      style: {
        '--bt-runtime-transition-duration': `${expanded ? SPRING_STRETCH.duration : SPRING_SHAPE.duration}ms`,
        '--bt-runtime-transition-easing': expanded ? SPRING_STRETCH.easing : SPRING_SHAPE.easing,
        ...dock.styleFor('runtime'),
      },
      onPointerEnter: () => { clearTimeout(hoverCloseTimer.current); if (!dock.dragging) { rememberRuntimeWidth(); setOpenForSession(sessionId) } },
      onPointerLeave: () => {
        if (dock.dragging || imagePreviewOpen.current) return
        clearTimeout(hoverCloseTimer.current)
        hoverCloseTimer.current = setTimeout(() => {
          if (imagePreviewOpen.current || hoverWrap.current?.matches(':hover') || document.querySelector('.bt-output-hover:hover')) return
          rememberRuntimeWidth()
          setOpenForSession(current => current === sessionId ? null : current)
        }, 160)
      },
      onFocusCapture: () => { rememberRuntimeWidth(); setOpenForSession(sessionId) },
      onBlurCapture: event => {
        if (!imagePreviewOpen.current && !event.currentTarget.contains(event.relatedTarget)) {
          rememberRuntimeWidth()
          setOpenForSession(current => current === sessionId ? null : current)
        }
      },
      onKeyDown: event => {
        if (open && event.key === 'Escape') {
          event.stopPropagation()
          rememberRuntimeWidth()
          setOpenForSession(null)
        }
      },
    },
    h('button', {
      type: 'button', className: 'bt-pill bt-media-progress-surface', 'aria-expanded': away ? undefined : dock.merged ? expanded : detailsOpen, 'data-memory': memoryNotice ? 'updated' : undefined,
      'aria-describedby': expanded ? panelId : undefined,
      title: away ? name : undefined,
      'aria-label': away ? t('Back to chat') : memoryNotice ? t("Memory updated. Open {name}'s memory", { name: roster.byId[changed]?.name ?? name }) : t('View conversation details'),
      ...dock.dragProps('runtime'),
      onClick: () => {
        if (away) { selectView('chat'); return }
        if (dock.consumeClick()) return
        if (dock.merged) { rememberRuntimeWidth(); setOpenForSession(current => current === sessionId ? null : sessionId); return }
        if (memoryNotice) actions.openMemory(changed)
        else actions.toggleDetails(sessionId)
      },
    },
    bot ? h(BotAvatar, { bot, size: 24, state: botState(running, doing, roster.questions?.[currentPart(bot)] !== undefined), badge: false })
      : room ? h(RoomAvatar, { room, roster, size: 24 }) : null,
    h('span', { className: 'bt-pill-name' }, away ? t('Back to chat') : bot?.name ?? room?.name ?? (title || t('New chat'))),
    memberStatus ? h('span', { className: 'bt-pill-status', role: 'status', 'aria-live': 'polite' }, h('span', { className: 'bt-pill-status-label' }, h(Shimmer, null, memberStatus)))
      : h(ActivityIndicator, { key: `activity:${sessionId}`, sessionId, useRoster, useSessionStatus, useSession, useLive, useToolState, useWork, actions }),
    h(MemoryNotice, { shown: memoryNotice }),
    dock.merged ? h('span', {
      className: 'bt-pill-output-count',
      title: t('Outputs ({count})', { count: outputCount }),
      'aria-label': t('Outputs ({count})', { count: outputCount }),
    }, h('span', { className: 'bt-outputs-label-icon', 'aria-hidden': true }, h(FolderIcon)), String(outputCount)) : null,
    dock.merged ? actions.mediaCapsuleProgress?.() : null,
    h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow))),
    mounted && panelStyle ? h(RuntimeStatusPanel, { sessionId, bot, roster, running, useLive, useToolState, panelId, style: panelStyle, expanded, memberStatus },
      hasOutputs && dock.merged ? h(OutputsCard, { key: sessionId, sessionId, useOutputs, useSession, actions, embedded: true,
        onHoverEnd: () => { if (!imagePreviewOpen.current && !hoverWrap.current?.matches(':hover')) setOpenForSession(null) },
        onPreviewChange: value => {
          imagePreviewOpen.current = value
          if (!value && !hoverWrap.current?.matches(':hover')) setOpenForSession(null)
        },
      }) : null) : null),
    h('span', { className: 'bt-sr', role: 'status' }, memoryNotice ? t('Memory updated') : ''),
    h(NewMessagePills, { key: sessionId, sessionId, useSessions, useUi, useTurnClock }),
    !hasOutputs || dock.merged ? null : h(OutputsCard, { key: sessionId, sessionId, useOutputs, useSession, actions, dock, surfaceRef: outputsRef, manual: outputsManual, setManual: setOutputsManual }))
}

// New-message pills. "N new messages ↓" takes Back to bottom's place when
// replies land while the user is scrolled up; "N new messages ↑" points at an unread
// divider above the viewport until it has been seen. The shell shows Back to bottom
// only while unpinned, so its presence is the pinned signal.
function useTranscriptView() {
  const [view, setView] = useState(null)
  useEffect(() => {
    let frame = 0
    let watched = null
    const observer = new MutationObserver(() => schedule())
    const measure = () => {
      frame = 0
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller !== watched) {
        observer.disconnect()
        watched = scroller
        if (scroller) observer.observe(scroller, { childList: true, subtree: true })
      }
      if (!scroller) { setView(null); return }
      const box = scroller.getBoundingClientRect()
      const headerBottom = document.querySelector('header[class*="_header"]')?.getBoundingClientRect().bottom ?? box.top + 50
      const sep = scroller.querySelector('.bt-new-sep')
      let divider = null
      if (sep) {
        const at = sep.getBoundingClientRect()
        divider = at.bottom <= headerBottom ? 'above' : at.top >= box.bottom ? 'below' : 'in-view'
      }
      const composer = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 152
      const next = {
        unpinned: scroller.querySelector('[class*="_toBottomSlot"]>button') !== null,
        divider,
        center: Math.round(box.left + box.width / 2),
        top: Math.round(headerBottom + 8),
        bottom: Math.round(viewBottom() - box.bottom + composer + 8),
      }
      setView(prev => (prev && Object.keys(next).every(key => prev[key] === next[key]) ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [])
  return view
}

function NewMessagePills({ sessionId, useSessions, useUi, useTurnClock }) {
  const replies = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.reduce((count, entry) => count + (entry.response ? 1 : 0), 0) : 0
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const unread = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number') return 0
    let count = 0
    for (const entry of Object.values(state[sessionId] ?? {})) {
      if (entry.first !== undefined && entry.first > visit.seen && entry.first <= visit.entered) count += 1
    }
    return count
  })
  const view = useTranscriptView()
  const unpinned = view?.unpinned === true
  const [release, setRelease] = useState({ base: null, dismissed: false })
  const [above, setAbove] = useState({ seen: false, dismissed: false })
  useEffect(() => { setRelease({ base: unpinned ? replies : null, dismissed: false }) }, [unpinned])
  useEffect(() => { if (view?.divider === 'in-view') setAbove(state => (state.seen ? state : { ...state, seen: true })) }, [view?.divider])
  const fresh = release.base === null ? 0 : replies - release.base
  const showDown = unpinned && fresh > 0 && !release.dismissed
  const showUp = view?.divider === 'above' && !above.seen && !above.dismissed
  useEffect(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!scroller) return undefined
    scroller.toggleAttribute('data-bt-news', showDown)
    return () => scroller.removeAttribute('data-bt-news')
  }, [showDown])
  if (!view || (!showDown && !showUp)) return null
  const label = count => (count === 1 ? t('1 new message') : count > 0 ? t('{count} new messages', { count }) : t('New messages'))
  const pill = (direction, count, style, onJump, onDismiss) => h('div', { className: 'bt-news', 'data-direction': direction, style },
    h('button', { type: 'button', className: 'bt-news-jump', onClick: onJump },
      h('span', { className: 'bt-news-ico' }, h(direction === 'up' ? ArrowUpIcon : ArrowDownIcon)), label(count)),
    h('button', {
      type: 'button', className: 'bt-news-x', 'aria-label': t('Dismiss new messages'),
      onClick: (event) => { event.stopPropagation(); onDismiss() },
    }, h(CloseIcon)))
  const toLatest = () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const back = scroller?.querySelector('[class*="_toBottomSlot"]>button')
    if (back) back.click()
    else scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }
  const toDivider = () => document.querySelector('[data-conversation-scroll] .bt-new-sep')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return createPortal(h(Fragment, null,
    showUp ? pill('up', unread, { left: view.center, top: view.top }, toDivider, () => setAbove(state => ({ ...state, dismissed: true }))) : null,
    showDown ? pill('down', fresh, { left: view.center, bottom: view.bottom }, toLatest, () => setRelease(state => ({ ...state, dismissed: true }))) : null),
  document.body)
}
