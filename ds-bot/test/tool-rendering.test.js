import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { toolRecords } from '../src/client/tool-records.js'

const bundled = await build({ entryPoints: ['src/client/cells.js'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], logLevel: 'silent' })

function renderer() {
  const state = new Map()
  let current = ''
  let hook = 0
  const Fragment = Symbol('Fragment')
  const DisclosureRow = Symbol('DisclosureRow')
  const module = { exports: {} }
  const react = {
    Fragment,
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children } : {}) } }),
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: value => ({ current: value }),
    useState: initial => {
      const key = `${current}:${hook++}`
      if (!state.has(key)) state.set(key, initial)
      return [state.get(key), next => state.set(key, typeof next === 'function' ? next(state.get(key)) : next)]
    },
  }
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require: name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: value => value }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { DisclosureRow, MarkdownText: Symbol('MarkdownText') }
    throw new Error(`Unexpected import ${name}`)
  } })
  const render = (element, path = 'root') => {
    if (element === null || element === undefined || typeof element !== 'object') return element
    if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}:${index}`))
    if (typeof element.type === 'function') {
      current = path; hook = 0
      return render(element.type(element.props), `${path}:${element.type.name}`)
    }
    return { ...element, props: { ...element.props, children: render(element.props.children, `${path}:children`) } }
  }
  return { render, ToolCell: module.exports.ToolCell, TurnTailCell: module.exports.TurnTailCell, recordActivity: module.exports.recordActivity, DisclosureRow }
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, predicate))
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)]
}

test('actual ToolCell collapses a run to one row, expands per-call rows and preserves multiline arguments', () => {
  const { render, ToolCell, DisclosureRow } = renderer()
  const command = 'cd J:\\work\n  Write-Host "hello"'
  const root = { kind: 'tool-result', callId: 'a', name: 'pwsh', call: { name: 'pwsh', argsRaw: JSON.stringify({ command }) }, content: [] }
  const next = { ...root, callId: 'b', name: 'read_file', call: { name: 'read_file', argsRaw: '{"path":"a.txt"}' } }
  const records = [...toolRecords(root), ...toolRecords(next)]
  const node = { key: 'a', data: { root }, location: { turn: { turn: 1 } } }
  const props = { node, sessionId: 'bot', useRoster: select => select({ rooms: [], roomsById: {}, exchangeTurns: {}, byId: { bot: {} }, bots: [] }), useToolState: select => select({ runs: new Map([['a', { records, hidden: false }]]) }), actions: { noteLive: () => {} } }
  const element = { type: ToolCell, props }
  let tree = render(element)
  let rows = elements(tree, item => item.type === DisclosureRow)
  assert.equal(rows.length, 1)
  assert.match(rows[0].props.title, /2/)
  rows[0].props.onToggle()
  tree = render(element)
  rows = elements(tree, item => item.type === DisclosureRow)
  assert.equal(rows.length, 3)
  assert.equal(elements(tree, item => item.props?.['data-chat-call-id']).length, 2)
  rows[1].props.onToggle()
  tree = render(element)
  const values = elements(tree, item => item.type === 'pre')
  assert.equal(values[0].props.children[0], command)
  const merged = render({ type: ToolCell, props: { ...props, useToolState: select => select({ runs: new Map([['a', { records, hidden: true }]]) }) } })
  assert.equal(merged.props.className, 'bt-tool-merged')
  assert.equal(merged.props.hidden, true)
})

test('completed Bot exchange gets a clickable reply event using durable trigger data', () => {
  const { TurnTailCell } = renderer()
  const peer = { id: 'peer', name: 'Other Bot' }
  const node = { data: { turn: 10, time: 1000, closing: { status: 'settled' } }, location: { turn: { end: { data: { reason: { kind: 'completed' } } } } } }
  let opened
  const turn = { turn: 10, end: { time: 1000, data: { reason: { kind: 'completed' } } } }
  const props = { turn, sessionId: 'bot', useRoster: select => select({ byId: { bot: { id: 'bot' }, peer }, roomsById: {}, exchangeTurns: { bot: [10] } }), useTurnSteps: () => [node.data.closing], useTurnTriggers: () => [{ source: { kind: 'bot', senderSessionId: 'peer' } }], useTurnClock: select => select({}), useUi: select => select({}), actions: { openExchange: (...args) => { opened = args }, noteTurnTime: () => {} } }
  const tree = TurnTailCell(props)
  const event = tree.props.children.find(child => child?.type?.name === 'EventLine')
  assert.equal(event.props.bots[0], peer)
  event.props.onOpen(peer)
  assert.deepEqual(opened, ['bot', 'peer'])
  assert.equal(TurnTailCell({ ...props, turn: { ...turn, end: { time: 1000, data: { reason: { kind: 'interrupted' } } } } }), null)
})

test('runtime activity retains the exact tool, object and authoritative start time', () => {
  const { recordActivity } = renderer()
  const entry = recordActivity({ name: 'pwsh', args: { command: 'python run_image.py' }, object: 'python run_image.py', at: 1234 }, { byId: {}, bots: [] })
  assert.match(entry.label, /pwsh/)
  assert.match(entry.label, /python run_image\.py/)
  assert.equal(entry.at, 1234)
})
