import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Shimmer, PHRASES } from './cells.js'
import { reducedMotion } from './motion.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The activity row: the Bot's mark and a shimmering phrase at the transcript
// tail while it works. It lives in the shell's running status, steps aside while a
// reply streams, and holds each phrase long enough to read.

const PHRASE_HOLD_MS = 800
const drawPhrase = pool => t(pool[Math.min(pool.length - 1, Math.floor(Math.random() * pool.length))])
export function elapsedLabel(ms) {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}
export { reducedMotion }

// New rows slide in. The first paint of a transcript, history
// loaded above, and bulk loads arrive without motion.
function useRowEntrances(replacing) {
  const check = useRef(replacing)
  check.current = replacing
  useEffect(() => {
    const seen = new WeakSet()
    const started = Date.now()
    let column = null
    let frame = 0
    const settle = (event) => {
      if (event.target !== event.currentTarget || !/^bt-row/.test(event.animationName)) return
      delete event.currentTarget.dataset.btEnter
      event.currentTarget.removeEventListener('animationend', settle)
    }
    const scan = () => {
      frame = 0
      const next = document.querySelector('[data-chat-flow]')
      if (next !== column) {
        observer.disconnect()
        column = next
        if (column) observer.observe(column, { childList: true, subtree: true })
      }
      if (!column) return
      const items = [...column.querySelectorAll(':scope > [data-chat-flow-key]')]
      let last = -1
      items.forEach((item, index) => { if (seen.has(item)) last = index })
      const fresh = items.filter(item => !seen.has(item) && item.offsetHeight > 0)
      for (const item of fresh) seen.add(item)
      if (last < 0 || Date.now() - started < 800 || fresh.length > 3) return
      for (const item of fresh) {
        if (items.indexOf(item) < last) continue
        const reply = [undefined, 'assistant-step', 'tool-call'].includes(item.dataset.chatFlowKind)
        item.dataset.btEnter = reply && check.current() ? 'after-collapse' : 'new'
        item.addEventListener('animationend', settle)
      }
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan) })
    scan()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [])
}

export function ActivityIndicator({ sessionId, useRoster, useSessionStatus, useLive, useSession, actions }) {
  const roster = useRoster(value => value)
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const liveKey = useLive(state => JSON.stringify(state[sessionId] ?? {}))
  const pendingInput = useSession(snapshot => Math.max(0, ...(snapshot?.pendingSubmissions ?? []).filter(sub => sub.placement !== 'queued').map(sub => sub.time)))
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const entries = useMemo(() => Object.values(JSON.parse(liveKey)), [liveKey])
  const streaming = entries.some(entry => entry.text)
  const tools = entries.filter(entry => !entry.text).sort((a, b) => a.at - b.at)
  const relaying = tools.some(entry => entry.relay)
  const visible = running && (bot !== undefined || room !== undefined)
  const tool = tools.at(-1)
  const inputRef = useRef(0)
  const inputAt = Math.max(inputRef.current, pendingInput)
  inputRef.current = inputAt
  const want = !visible ? null
    : streaming ? { key: 'replying', label: t('Generating a response'), state: 'working' }
      : relaying ? { key: 'relaying', label: tool?.label ?? t('Coordinating with Bots'), state: tool?.state ?? 'working' }
        : inputAt > (tool?.at ?? 0)
          ? { key: `input:${inputAt}`, pool: PHRASES.thinking, state: 'thinking' }
          : tool ? { key: tool.label ? `tool:${tool.label}` : 'working', label: tool.label, pool: PHRASES.working, state: tool.state ?? 'working' }
            : { key: 'thinking', pool: PHRASES.thinking, state: 'thinking' }
  const [shown, setShown] = useState(null)
  const wantKey = want?.key ?? null
  useEffect(() => {
    if (wantKey === null || shown?.key === wantKey) return undefined
    const make = () => setShown({ key: wantKey, text: want.label ?? drawPhrase(want.pool), at: Date.now() })
    const wait = shown ? shown.at + PHRASE_HOLD_MS - Date.now() : 0
    if (wait <= 0) { make(); return undefined }
    const timer = setTimeout(make, wait)
    return () => clearTimeout(timer)
  }, [wantKey, shown])
  const [phase, setPhase] = useState(null)
  const endedAt = useRef(0)
  const leaving = useRef(false)
  leaving.current = phase !== null && !visible
  useEffect(() => {
    if (visible) { setPhase('in'); return undefined }
    setPhase(current => (current === 'in' ? 'out' : current))
    const timer = setTimeout(() => setPhase(current => (current === 'out' ? null : current)), 140)
    return () => clearTimeout(timer)
  }, [visible])
  useLayoutEffect(() => {
    if (phase !== null) return
    endedAt.current = Date.now()
    setShown(null)
  }, [phase])
  useEffect(() => { if (!running) actions.clearLive(sessionId) }, [running, sessionId])
  useRowEntrances(() => leaving.current || Date.now() - endedAt.current < 300)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (phase !== 'in') return undefined
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [phase])
  if (phase === null || !shown) return null
  const elapsed = now - shown.at >= 60000 ? elapsedLabel(now - shown.at) : null
  return h('span', { className: 'bt-pill-status', 'data-exiting': phase === 'out' ? '' : undefined, role: 'status', 'aria-live': 'polite' },
    h('span', { key: `${shown.key}:${shown.at}`, className: 'bt-pill-status-label' }, h(Shimmer, null, `${shown.text}…`)),
    elapsed ? h('span', { className: 'bt-pill-status-time' }, `· ${elapsed}`) : null)
}
