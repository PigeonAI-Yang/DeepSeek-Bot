import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SPRING_SHAPE, reducedMotion } from './motion.js'

export const dockNear = (moving, target) => moving.left < target.right + 24 && moving.right > target.left - 24
  && moving.top < target.bottom + 24 && moving.bottom > target.top - 24
export const splitFling = (distance, speed) => distance >= 90 && speed >= 1100

const initial = () => ({ merged: false, at: null, offsets: {}, dragging: null, target: null, settling: false })
export function useCapsuleDock({ sessionId, runtimeRef, outputsRef, onMerge, onSplit }) {
  const [state, setState] = useState(initial)
  const current = useRef(state)
  current.current = state
  const callbacks = useRef({ onMerge, onSplit })
  callbacks.current = { onMerge, onSplit }
  const homes = useRef({})
  const cleanup = useRef(() => {})
  const suppressClick = useRef(false)
  const timers = useRef([])
  const frames = useRef([])
  const joining = useRef(null)
  const joinFrom = useRef(null)
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.current.push(timer) }
  const frame = fn => { frames.current.push(requestAnimationFrame(fn)) }
  const returnHome = () => {
    frame(() => frame(() => setState(value => ({ ...value, offsets: {}, settling: true }))))
    later(() => setState(value => ({ ...value, settling: false })), SPRING_SHAPE.duration + 80)
  }
  useEffect(() => {
    cleanup.current()
    setState(initial())
    homes.current = {}
    return () => { cleanup.current(); joining.current?.cancel(); timers.current.forEach(clearTimeout); timers.current = []; frames.current.forEach(cancelAnimationFrame); frames.current = [] }
  }, [sessionId])
  useLayoutEffect(() => {
    const node = runtimeRef.current
    const from = joinFrom.current
    joinFrom.current = null
    if (!state.merged || !from || !node || reducedMotion()) return
    joining.current?.cancel()
    const to = node.getBoundingClientRect()
    joining.current = node.animate([
      { transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(.97,1.03)` },
      { transform: 'none' },
    ], { duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing })
  }, [state.merged])

  const dragProps = kind => ({
    onDragStart: event => event.preventDefault(),
    onPointerDown(event) {
      if (event.button !== 0 || current.current.dragging) return
      const node = kind === 'runtime' ? runtimeRef.current : outputsRef.current
      const peer = kind === 'runtime' ? outputsRef.current : runtimeRef.current
      if (!node) return
      cleanup.current()
      timers.current.forEach(clearTimeout)
      timers.current = []
      frames.current.forEach(cancelAnimationFrame)
      frames.current = []
      suppressClick.current = false
      joining.current?.cancel()
      const before = current.current
      const origin = node.getBoundingClientRect()
      const handle = node.querySelector(kind === 'runtime' ? '.bt-pill' : '.bt-outputs-toggle')?.getBoundingClientRect() ?? origin
      const peerHandle = peer?.querySelector(kind === 'runtime' ? '.bt-outputs-toggle' : '.bt-pill')?.getBoundingClientRect()
      if (!before.merged && peer) {
        homes.current = { runtime: runtimeRef.current.getBoundingClientRect(), outputs: outputsRef.current.getBoundingClientRect() }
      }
      const start = { x: event.clientX, y: event.clientY }
      const capture = event.currentTarget
      capture.setPointerCapture?.(event.pointerId)
      let moved = false
      let maxDistance = 0
      let offset = { x: 0, y: 0 }
      let near = false
      let samples = [{ x: start.x, y: start.y, t: event.timeStamp }]
      const move = pointer => {
        if (pointer.pointerId !== event.pointerId) return
        offset = { x: pointer.clientX - start.x, y: pointer.clientY - start.y }
        maxDistance = Math.max(maxDistance, Math.hypot(offset.x, offset.y))
        if (!moved && maxDistance < 6) return
        moved = true
        suppressClick.current = true
        samples.push({ x: pointer.clientX, y: pointer.clientY, t: pointer.timeStamp })
        samples = samples.filter(sample => pointer.timeStamp - sample.t <= 100)
        const rect = { left: handle.left + offset.x, right: handle.right + offset.x, top: handle.top + offset.y, bottom: handle.bottom + offset.y }
        near = !before.merged && peerHandle && dockNear(rect, peerHandle)
        setState({ ...before, dragging: kind, offsets: { [kind]: offset }, target: near ? (kind === 'runtime' ? 'outputs' : 'runtime') : null, settling: false })
      }
      const stop = pointer => {
        if (pointer.pointerId !== event.pointerId) return
        cleanup.current()
        if (!moved) return
        later(() => { suppressClick.current = false }, 0)
        if (pointer.type !== 'pointercancel' && before.merged) {
          const sample = samples[0]
          const dt = Math.max(1, pointer.timeStamp - sample.t)
          const speed = Math.hypot(pointer.clientX - sample.x, pointer.clientY - sample.y) * 1000 / dt
          if (splitFling(maxDistance, speed)) {
            const returning = {}
            for (const name of ['runtime', 'outputs']) {
              const home = homes.current[name]
              if (home) returning[name] = { x: origin.left + offset.x - home.left, y: origin.top + offset.y - home.top }
            }
            setState({ ...initial(), offsets: returning })
            returnHome()
            callbacks.current.onSplit?.()
            return
          }
          setState({ ...before, at: { x: origin.left + origin.width / 2 + offset.x, y: Math.max(40, Math.min(innerHeight - 48, origin.top + offset.y)) }, offsets: {}, dragging: null, target: null })
          return
        }
        if (pointer.type !== 'pointercancel' && near) {
          joinFrom.current = node.getBoundingClientRect()
          setState({ ...initial(), merged: true, at: { x: peerHandle.left + peerHandle.width / 2, y: peerHandle.top } })
          callbacks.current.onMerge?.()
          return
        }
        setState({ ...before, dragging: null, offsets: { [kind]: offset }, target: null })
        returnHome()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      const cancel = () => stop({ pointerId: event.pointerId, type: 'pointercancel', clientX: start.x + offset.x, clientY: start.y + offset.y, timeStamp: performance.now() })
      const escape = key => { if (key.key === 'Escape' && moved) { key.preventDefault(); key.stopPropagation(); cancel() } }
      window.addEventListener('blur', cancel)
      window.addEventListener('keydown', escape, true)
      cleanup.current = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('blur', cancel)
        window.removeEventListener('keydown', escape, true)
        if (capture.isConnected && capture.hasPointerCapture?.(event.pointerId)) capture.releasePointerCapture(event.pointerId)
      }
    },
  })
  const styleFor = kind => {
    const offset = state.offsets[kind] ?? { x: 0, y: 0 }
    return { '--bt-drag-x': `${offset.x}px`, '--bt-drag-y': `${offset.y}px`,
      ...(kind === 'runtime' && state.merged ? { position: 'fixed', left: `clamp(min(196px,50vw),${state.at.x}px,max(calc(100vw - 196px),50vw))`, top: `clamp(40px,${state.at.y}px,calc(100vh - 60px))` } : {}) }
  }
  const attrsFor = kind => ({ 'data-dock-dragging': state.dragging === kind ? '' : undefined,
    'data-dock-target': state.target === kind ? '' : undefined, 'data-dock-settling': state.settling ? '' : undefined })
  return { ...state, dragProps, styleFor, attrsFor, consumeClick: () => suppressClick.current }
}
