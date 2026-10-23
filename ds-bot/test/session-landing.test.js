import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const source = new URL('../src/client/sidebar.js', import.meta.url)
const bundle = await build({
  stdin: { contents: `${readFileSync(process.env.DS_BOT_LANDING_SOURCE ?? source, 'utf8')}\nexport { useLandOnMainBot }`, resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function start() {
  const timers = new Map()
  const ref = { current: null }
  const calls = []
  let effect
  let dependencies
  let cleanup
  let serial = 0
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? { useRef: () => ref, useEffect: (run, next) => {
      if (dependencies && next.every((value, index) => Object.is(value, dependencies[index]))) return
      dependencies = next
      effect = run
    } } : {},
    setTimeout: run => { const id = ++serial; timers.set(id, run); return id },
    clearTimeout: id => timers.delete(id),
  })
  const bot = { id: 'main', sessionId: 'part-1' }
  const roster = { ready: true, mainBotId: bot.id, byId: { main: bot, 'part-1': bot }, roomsById: {}, agentOf: {} }
  return {
    calls, roster,
    render(list) {
      effect = undefined
      module.exports.useLandOnMainBot(roster, select => select(list), { landOn: (...args) => calls.push(args) })
      if (effect) { cleanup?.(); cleanup = effect() }
    },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(run => run()) },
  }
}

test('reload waits for the Session catalog then lands on the existing Bot part', () => {
  const app = start()
  app.render({ phase: 'pending', byId: {} })
  app.flush()
  assert.equal(app.calls.length, 0)
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1' } } })
  app.flush()
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0][0], 'main')
})

test('a stale roster target is not opened or created', () => {
  const app = start()
  app.render({ phase: 'ready', byId: {} })
  app.flush()
  assert.equal(app.calls.length, 0)
})

test('a later catalog addition schedules landing even when the phase is already ready', () => {
  const app = start()
  app.render({ phase: 'ready', byId: {} })
  app.flush()
  assert.equal(app.calls.length, 0)
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1' } } })
  app.flush()
  assert.equal(app.calls.length, 1)
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1', updatedAt: 2 } } })
  app.flush()
  assert.equal(app.calls.length, 1)
})

test('part migration waits for the new part and keeps the old identity', () => {
  const app = start()
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1', retainedBy: { mainView: 1 } } } })
  const next = { id: 'main', sessionId: 'part-2' }
  app.roster.byId = { main: next, 'part-1': next, 'part-2': next }
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1', retainedBy: { mainView: 1 } } } })
  app.flush()
  assert.equal(app.calls.length, 0)
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1', retainedBy: { mainView: 1 } }, 'part-2': { id: 'part-2' } } })
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0][0], 'main')
})

test('an existing Agent destination stays selected', () => {
  const app = start()
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1' }, agent: { id: 'agent', blank: false, retainedBy: { mainView: 1 } } } })
  app.flush()
  assert.equal(app.calls.length, 0)
})

test('removing a target cancels the pending landing', () => {
  const app = start()
  app.render({ phase: 'ready', byId: { 'part-1': { id: 'part-1' } } })
  app.render({ phase: 'ready', byId: {} })
  app.flush()
  assert.equal(app.calls.length, 0)
})
