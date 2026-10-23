import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { localFilePath } from '../src/client/file-paths.js'
import { localPathSpans, linkLocalPaths } from '../src/client/text.js'

const path = 'C:/Users/yangda01/.dsh/attachments/v1/files/f9/artifact-image-4821.png'
const bundled = await build({ entryPoints: ['src/client/path-actions.js'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' })
const module = { exports: {} }
runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { createPathActions, pathMentions } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

test('complete local file tokens preserve slashes, quotes, spaces and Unicode without accepting commands', () => {
  for (const value of [path, 'C:\\Users\\name\\photo.png', '"J:/我的目录/图片.png"']) assert.ok(localFilePath(value))
  for (const value of ['https://x/C:/a.png', 'file:///C:/a.png', 'C:relative.png', 'C:/folder/', 'C:/a.png;start calc', 'C:/a.png + next.js', 'read("C:/a.png")', 'C:/a.png\nD:/b.png']) assert.equal(localFilePath(value), null, value)
})

test('prose conversion leaves code, commands, existing links and URL paths intact', () => {
  const protectedText = ['```pwsh\nGet-Item C:/a.png\n```', '    Get-Item C:/a.png', '`C:/a.png`', '[file](C:/a.png)', 'https://x/C:/a.png', 'object=C:/a.png']
  for (const value of protectedText) assert.equal(linkLocalPaths(value), value, value)
  assert.equal(localPathSpans('文件：'+path+'。')[0].path, path)
  assert.equal(localPathSpans('打开 "J:/my images/a.png"')[0].path, 'J:/my images/a.png')
  assert.equal(linkLocalPaths('C:\\Users\\name\\a.png'), '[C:\\\\Users\\\\name\\\\a.png](<C:/Users/name/a.png>)')
})

test('existing official mentions keep precedence and complete paths call the supplied preview', () => {
  const original = { title: 'existing', open: () => {} }
  const opened = []
  const mentions = pathMentions({ resolve: value => value === 'existing.png' ? original : undefined }, value => opened.push(value))
  assert.equal(mentions.resolve('existing.png'), original)
  mentions.resolve(path).open()
  assert.deepEqual(opened, [path])
  assert.equal(mentions.resolve('Get-Item '+path), undefined)
})

test('native menu adapter uses only the official desktop availability, association and open requests', async () => {
  const calls = []
  const remote = { session: {
    canOpenWorkspacePath: async () => ({ ok: true, value: true }),
    workspacePathApplications: async request => { calls.push(['applications', plain(request)]); return { ok: true, value: [{ id: 'paint.exe', name: 'Paint' }] } },
    openWorkspacePath: async request => { calls.push(['open', plain(request)]); return { ok: true, value: { opened: true } } },
  } }
  const actions = createPathActions(remote)
  assert.equal((await actions.applications(path))[0].id, 'paint.exe')
  await actions.open(path, 'open')
  await actions.open(path, 'open', 'paint.exe')
  await actions.open(path, 'reveal')
  assert.deepEqual(calls, [['applications', { path }], ['open', { path }], ['open', { path, application: 'paint.exe' }], ['open', { path, action: 'reveal' }]])
  remote.session.canOpenWorkspacePath = async () => ({ ok: true, value: false })
  assert.equal(await actions.applications(path), null)
  remote.session.openWorkspacePath = async () => ({ ok: false })
  await assert.rejects(actions.open(path, 'open'))
})


test('junction aliases resolve through official session file metadata after native mapping refusal', async () => {
  const canonical = 'J:/dsh-bot/data/attachments/v1/files/f9/artifact-image-4821.png'
  const calls = []
  const refused = { ok: false, error: { message: 'Path has no verified Host path' } }
  const remote = {
    session: {
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      workspacePathApplications: async request => { calls.push(['apps', request.path]); return request.path === path ? refused : { ok: true, value: [{ id: 'wps', name: 'WPS 图片' }] } },
      openWorkspacePath: async request => { calls.push(['open', plain(request)]); return request.path === path ? refused : { ok: true } },
    },
    workspaceFiles: { stat: async (sessionId, value) => { calls.push(['stat', sessionId, value]); return { ok: true, value: { absolutePath: canonical } } } },
  }
  const actions = createPathActions(remote)
  assert.equal((await actions.applications(path, undefined, 'session'))[0].id, 'wps')
  await actions.open(path, 'open', 'wps', 'session')
  await actions.open(path, 'reveal', undefined, 'session')
  assert.deepEqual(calls, [
    ['apps', path], ['stat', 'session', path], ['apps', canonical],
    ['open', { path, application: 'wps' }], ['stat', 'session', path], ['open', { path: canonical, application: 'wps' }],
    ['open', { path, action: 'reveal' }], ['stat', 'session', path], ['open', { path: canonical, action: 'reveal' }],
  ])
})

test('native association failures stay unavailable and other failures never trigger metadata or retries', async () => {
  let calls = 0
  const remote = { session: {
    canOpenWorkspacePath: async () => ({ ok: true, value: true }),
    workspacePathApplications: async () => { calls++; return { ok: false, error: { message: 'Access denied' } } },
  }, workspaceFiles: { stat: async () => { throw new Error('Unexpected metadata read') } } }
  assert.equal(await createPathActions(remote).applications(path, undefined, 'session'), null)
  assert.equal(calls, 1)
})
