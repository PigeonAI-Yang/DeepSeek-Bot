import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'
import { localFilePath } from './file-paths.js'
export { localFilePath } from './file-paths.js'

export function pathMentions(mentions, openFile) {
  if (typeof openFile !== 'function') return mentions
  return {
    ...mentions,
    resolve(value) {
      const existing = mentions?.resolve(value)
      if (existing !== undefined) return existing
      const path = localFilePath(value)
      return path === null ? undefined : { title: path, label: path, open: () => openFile(path) }
    },
  }
}

export function createPathActions(remote) {
  const nativeRequest = async (path, sessionId, signal, operation) => {
    const result = await operation(path)
    if (result.ok || result.error?.message !== 'Path has no verified Host path' || !sessionId) return result
    const resolved = await remote.workspaceFiles.stat(sessionId, path, signal)
    if (!resolved.ok || !localFilePath(resolved.value.absolutePath)) return result
    return operation(resolved.value.absolutePath)
  }
  return {
    async applications(path, signal, sessionId) {
      if (!remote?.session || !localFilePath(path)) return null
      const available = await remote.session.canOpenWorkspacePath()
      if (signal?.aborted) return null
      if (!available.ok || !available.value) return null
      const result = await nativeRequest(path, sessionId, signal, resolved => remote.session.workspacePathApplications({ path: resolved }, signal))
      return result.ok ? result.value : null
    },
    async open(path, action, application, sessionId) {
      if (!remote?.session || !localFilePath(path)) throw new Error('File opening is unavailable')
      const result = await nativeRequest(path, sessionId, undefined, resolved => remote.session.openWorkspacePath(action === 'reveal' ? { path: resolved, action } : { path: resolved, ...(application === undefined ? {} : { application }) }))
      if (!result.ok) throw new Error('Could not open the file')
    },
  }
}

export function pathEventTarget(target, root) {
  const element = target?.closest?.('code,button[data-bt-path],button[title]')
  if (!element || !root.contains(element) || element.closest('pre,a')) return null
  const code = element.closest('code')
  return localFilePath(code?.textContent ?? element.getAttribute('data-bt-path') ?? element.getAttribute('title'))
}

function PathMenu({ target, pathActions, onClose }) {
  const ref = useRef(null)
  const [place, setPlace] = useState({ left: target.x, top: target.y })
  const [apps, setApps] = useState(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEscape(onClose)
  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve(pathActions?.applications(target.path, controller.signal, target.sessionId) ?? null).then(value => {
      if (!controller.signal.aborted) setApps(value)
    }).catch(() => { if (!controller.signal.aborted) setApps(null) })
    const outside = event => { if (!ref.current?.contains(event.target)) onClose() }
    const close = () => onClose()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    ref.current?.querySelector('button')?.focus({ preventScroll: true })
    return () => {
      controller.abort()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
      if (target.opener?.isConnected) target.opener.focus({ preventScroll: true })
    }
  }, [target, pathActions])
  useLayoutEffect(() => {
    if (ref.current) setPlace({ left: Math.max(8, Math.min(target.x, innerWidth - ref.current.offsetWidth - 8)), top: Math.max(8, Math.min(target.y, innerHeight - ref.current.offsetHeight - 8)) })
  }, [target, apps, error])
  const run = async operation => {
    if (pending) return
    setPending(true); setError('')
    try { await operation(); onClose() } catch { setError(t('The file action failed. Please try again.')) } finally { setPending(false) }
  }
  const item = (label, operation, disabled = false) => h('button', { key: label, type: 'button', role: 'menuitem', disabled: pending || disabled, onClick: () => void run(operation) }, label)
  const keyDown = event => {
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]
    const at = buttons.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (at + 1) % buttons.length : event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length : -1
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
  }
  return h('div', { ref, className: 'bt-menu bt-path-menu', role: 'menu', 'aria-label': t('File actions'), style: place, onKeyDown: keyDown },
    item(t('Preview file'), () => target.openFile(target.path)),
    apps ? item(t('Open'), () => pathActions.open(target.path, 'open', undefined, target.sessionId)) : null,
    apps?.length ? h('div', { className: 'bt-path-menu-label' }, t('Open with')) : null,
    apps?.map(app => item(app.name, () => pathActions.open(target.path, 'open', app.id, target.sessionId))),
    apps ? item(t('Show in folder'), () => pathActions.open(target.path, 'reveal', undefined, target.sessionId)) : null,
    item(t('Copy path'), () => navigator.clipboard.writeText(target.path)),
    apps === undefined ? h('div', { className: 'bt-path-menu-label', role: 'status' }, t('Loading…')) : null,
    error ? h('div', { className: 'bt-image-menu-error', role: 'alert' }, error) : null)
}

export function ChatPathActions({ children, openFile, pathActions, sessionId }) {
  const ref = useRef(null)
  const [target, setTarget] = useState(null)
  const contextMenu = event => {
    if (typeof openFile !== 'function') return
    const path = pathEventTarget(event.target, ref.current)
    if (!path) return
    event.preventDefault(); event.stopPropagation()
    setTarget({ path, sessionId, x: event.clientX, y: event.clientY, opener: event.target.closest('button'), openFile })
  }
  const preserveSelection = event => {
    if (window.getSelection()?.isCollapsed === false && pathEventTarget(event.target, ref.current)) { event.preventDefault(); event.stopPropagation() }
  }
  return h('div', { ref, className: 'bt-path-text', onContextMenuCapture: contextMenu, onClickCapture: preserveSelection }, children,
    target ? createPortal(h(PathMenu, { target, pathActions, onClose: () => setTarget(null) }), document.body) : null)
}

export const PATH_ACTIONS_CSS = `
.bt-path-text{min-width:0}
.bt-path-text code>button,.bt-path-text [data-bt-path]{white-space:inherit;overflow-wrap:anywhere;word-break:break-word;user-select:text}
.bt-path-text code:has(>button[class*="_fileMention_"]){display:inline-block;max-width:100%;vertical-align:top}
.bt-path-text code>button[class*="_fileMention_"]{display:inline-flex;max-width:100%;align-items:flex-start;text-align:left;vertical-align:top}
.bt-path-text code>button[class*="_fileMention_"]>svg{display:block;flex:none;width:14px;height:14px;margin-top:.2em}
.bt-path-menu{z-index:210;max-width:min(320px,calc(100vw - 16px));max-height:min(360px,calc(100dvh - 16px));overflow-y:auto;overscroll-behavior:contain}
.bt-path-menu>*{flex-shrink:0}
.bt-path-menu button:focus-visible{background:var(--bt-hover);outline:1px solid var(--bt-line-2);outline-offset:-1px}
.bt-path-menu button:disabled{opacity:.5;cursor:wait}
.bt-path-menu-label{padding:5px 8px;color:var(--bt-ink-3);font-size:12px;line-height:18px}
`
