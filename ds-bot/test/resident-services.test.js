import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { serviceTarget, probeService, createResidentServices, install } from '../src/host/resident-services.js'
import { fakeContext } from './fake-ctx.js'

const target = { name: 'ComfyUI', kind: 'comfyui', origin: 'http://127.0.0.1:8188' }

test('service targets admit only exact loopback origins without credentials or request parameters', () => {
  assert.equal(serviceTarget({ ...target, origin: 'http://localhost:8188' }).origin, target.origin)
  assert.equal(serviceTarget({ ...target, origin: 'http://[::1]:8188' }).origin, 'http://[::1]:8188')
  for (const origin of ['http://example.com:8188', 'http://127.0.0.1.example.com', 'file:///a', 'http://user:secret@127.0.0.1:8188', 'http://127.0.0.1:8188/stop', 'http://127.0.0.1:8188/?token=a', 'http://127.0.0.1:8188/#a']) {
    assert.throws(() => serviceTarget({ ...target, origin }))
  }
})

test('resident service liveness expires, refreshes without history and pauses denied checks', async () => {
  let time = 100
  let calls = 0
  let result = { live: true }
  const registry = createResidentServices({ now: () => time, probe: async () => { calls++; return result } })
  await registry.observe('bot-a', target)
  assert.equal(registry.view()['bot-a'][0].name, 'ComfyUI')
  assert.equal(registry.view()['bot-b'], undefined)
  await registry.refresh()
  assert.equal(calls, 1)
  time += 5_001
  assert.deepEqual(registry.view(), {})
  result = { live: false }
  await registry.refresh()
  assert.deepEqual(registry.view(), {})
  time += 5_001
  result = { live: false, paused: true }
  await registry.refresh()
  const pausedCalls = calls
  time += 50_000
  await registry.refresh()
  assert.equal(calls, pausedCalls)
  result = { live: true }
  await registry.observe('bot-a', target)
  assert.equal(registry.view()['bot-a'].length, 1)
  registry.dispose()
  assert.deepEqual(registry.view(), {})
})

test('concurrent state refreshes share one pending service check', async () => {
  let release
  let calls = 0
  const registry = createResidentServices({ probe: () => { calls++; return new Promise(resolve => { release = resolve }) } })
  const observe = registry.observe('bot-a', target)
  const first = registry.refresh()
  const second = registry.refresh()
  await Promise.resolve()
  assert.equal(calls, 1)
  release({ live: true })
  await Promise.all([observe, first, second])
  assert.equal(registry.view()['bot-a'][0].status, 'running')
})

test('real HTTP probe validates ComfyUI identity, rejects redirects, bounds waits and pauses refusals', async t => {
  let mode = 'healthy'
  let redirected = 0
  const server = createServer((request, response) => {
    if (request.url !== '/system_stats') redirected++
    if (mode === 'hang') return
    if (mode === 'redirect') { response.writeHead(302, { location: '/somewhere' }); response.end(); return }
    if (mode === 'denied') { response.writeHead(403); response.end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(mode === 'healthy' ? { system: { comfyui_version: '1.0' }, devices: [] } : { ok: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const local = { ...target, origin: `http://127.0.0.1:${server.address().port}` }
  assert.deepEqual(await probeService(local), { live: true })
  mode = 'wrong-app'
  assert.deepEqual(await probeService(local), { live: false })
  mode = 'redirect'
  assert.deepEqual(await probeService(local), { live: false })
  assert.equal(redirected, 0)
  mode = 'denied'
  assert.deepEqual(await probeService(local), { live: false, paused: true })
  mode = 'hang'
  assert.deepEqual(await probeService(local, { timeoutMs: 30 }), { live: false })
})

test('service observation tool derives its owner from the current Bot part and refuses outsiders', async t => {
  const ctx = fakeContext()
  const rt = { ctx, load: async () => {}, selfOf: id => id === 'later-part' ? 'bot-a' : id, botOf: id => id === 'bot-a' ? { id } : undefined }
  install(rt)
  t.after(() => ctx.dispose())
  const tool = ctx.registeredTools.get('observe_resident_service')
  assert.match(await tool.execute(target, { agent: { id: 'outside' } }), /Only Bots/)
  assert.deepEqual(rt.residentServicesView(), {})
  const server = createServer((_request, response) => response.end(JSON.stringify({ system: { comfyui_version: 'test' }, devices: [] })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  await tool.execute({ ...target, origin: `http://127.0.0.1:${server.address().port}` }, { agent: { id: 'later-part' } })
  assert.equal(rt.residentServicesView()['bot-a'][0].name, 'ComfyUI')
  assert.equal(rt.residentServicesView()['later-part'], undefined)
})
