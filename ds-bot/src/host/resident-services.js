import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { defineTool } from '@deepseek-ai/dsh-tools'

const CACHE_MS = 5_000
const MAX_SERVICES = 16

export function serviceTarget({ name, kind, origin }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 48 || /[\r\n]/.test(name)) throw new TypeError('Give the service a short name')
  if (kind !== 'comfyui' && kind !== 'http') throw new TypeError('Service kind must be comfyui or http')
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('Use a local HTTP service origin without credentials, paths or parameters')
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  if (!/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname) && url.hostname !== '[::1]') throw new TypeError('Only loopback services can be observed')
  return { id: url.origin, name: name.trim(), kind, origin: url.origin }
}

export function probeService(target, { timeoutMs = 1_200 } = {}) {
  const url = new URL(target.kind === 'comfyui' ? '/system_stats' : '/', target.origin)
  return new Promise(resolve => {
    let settled = false
    let timer
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // Direct loopback HTTP avoids routing local checks through a user's proxy.
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { agent: false }, response => {
      const code = response.statusCode ?? 0
      if ([401, 403, 429].includes(code)) {
        finish({ live: false, paused: true })
        response.destroy()
        return
      }
      if (code < 200 || code >= 300) {
        finish({ live: false })
        response.destroy()
        return
      }
      if (target.kind === 'http') {
        finish({ live: true })
        response.destroy()
        return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 131_072) { finish({ live: false }); response.destroy() }
        else chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          finish({ live: typeof value.system?.comfyui_version === 'string' && Array.isArray(value.devices) })
        } catch { finish({ live: false }) }
      })
      response.on('error', () => finish({ live: false }))
      response.on('aborted', () => finish({ live: false }))
    })
    request.on('error', () => finish({ live: false }))
    timer = setTimeout(() => { finish({ live: false }); request.destroy() }, timeoutMs)
  })
}

export function createResidentServices({ probe = probeService, now = Date.now } = {}) {
  const owners = new Map()
  let disposed = false
  const check = entry => {
    if (entry.pending) return entry.pending
    if (entry.paused || (entry.checkedAt !== undefined && now() - entry.checkedAt < CACHE_MS)) return Promise.resolve()
    entry.live = false
    entry.pending = Promise.resolve().then(() => probe(entry)).catch(() => ({ live: false })).then(result => {
      entry.live = result.live === true
      entry.paused = result.paused === true
      entry.checkedAt = now()
    }).finally(() => { entry.pending = undefined })
    return entry.pending
  }
  return {
    async observe(owner, args) {
      if (disposed) throw new Error('Service observer is closed')
      const target = serviceTarget(args)
      let entries = owners.get(owner)
      if (!entries) { entries = new Map(); owners.set(owner, entries) }
      const previous = entries.get(target.id)
      if (!previous && entries.size >= MAX_SERVICES) throw new Error('Too many observed services for this Bot')
      const entry = { ...target, live: false }
      entries.set(target.id, entry)
      await check(entry)
      return { name: entry.name, live: entry.live, paused: entry.paused }
    },
    async refresh() {
      if (disposed) return
      await Promise.all([...owners.values()].flatMap(entries => [...entries.values()].map(check)))
    },
    view() {
      if (disposed) return {}
      return Object.fromEntries([...owners].map(([owner, entries]) => [owner, [...entries.values()]
        .filter(entry => entry.live && !entry.paused && now() - entry.checkedAt < CACHE_MS)
        .map(({ id, name }) => ({ id, name, status: 'running' }))]).filter(([, entries]) => entries.length))
    },
    dispose() { disposed = true; owners.clear() },
  }
}

export function install(rt) {
  const registry = createResidentServices()
  rt.refreshResidentServices = () => registry.refresh()
  rt.residentServicesView = () => registry.view()
  rt.ctx.effect(() => () => registry.dispose(), 'ds-bot: resident service observations')
  rt.ctx.tools.register(defineTool({
    name: 'observe_resident_service',
    description: 'Show a local resident service you started or are using in your runtime capsule. Only observes its read-only health endpoint; does not start or stop it. Observations last until the DS Bot host restarts.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, for example ComfyUI' },
      kind: { type: 'string', required: true, enum: ['comfyui', 'http'], description: 'comfyui checks /system_stats; http checks the root page for a successful response' },
      origin: { type: 'string', required: true, description: 'Exact known loopback HTTP origin, for example http://127.0.0.1:8188. No path, credentials or parameters' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      await rt.load()
      const owner = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(owner)) return 'Only Bots on the team can observe resident services.'
      const result = await registry.observe(owner, args)
      return result.live ? `${result.name} is responding and appears in your runtime capsule.`
        : result.paused ? `${result.name} refused the check. Observation is paused until explicitly registered again.`
          : `${result.name} is not responding as expected and is hidden from the runtime capsule.`
    },
  }))
}
