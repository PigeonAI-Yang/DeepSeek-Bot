import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const bundle = await build({ entryPoints: ['src/client/image-preview.js'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' })
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { captureImageInput } = module.exports

function fixture() {
  const binding = { ctx: {} }
  const state = { binding, current: 'one', draft: 'existing text', ids: ['existing'], released: [], focused: 0, created: 0, busy: false }
  const sessions = { binding: () => state.binding }
  const input = {
    addAttachments(ids) { if (state.busy) return false; state.ids.push(...ids); return true },
    focus() { state.focused += 1 },
  }
  const conversation = {
    input: { for(scope) { assert.equal(scope, binding.ctx); return input } },
    createDrafts(id, files) { assert.equal(id, 'one'); state.created += 1; state.file = files[0]; return [{ id: 'annotated' }] },
    releaseDraftAttachments(drafts) { state.released.push(...drafts.map(draft => draft.id)) },
  }
  return { state, sessions, conversation, capture: () => captureImageInput(sessions, conversation, 'one', () => state.current) }
}

test('annotation appends to the captured draft without replacing text, attachments or submitting', () => {
  const { state, capture } = fixture()
  const file = { name: 'scene-annotated.png', type: 'image/png' }
  const focus = capture()(file)
  assert.equal(state.file, file)
  assert.deepEqual(state.ids, ['existing', 'annotated'])
  assert.equal(state.draft, 'existing text')
  assert.deepEqual(state.released, [])
  assert.equal(state.focused, 0)
  focus()
  assert.equal(state.focused, 1)
})

test('session switches and generation replacements refuse annotation before draft allocation', () => {
  for (const change of [state => { state.current = 'two' }, state => { state.binding = { ctx: {} } }]) {
    const { state, capture } = fixture()
    const add = capture()
    change(state)
    assert.throws(() => add({}), /original conversation/)
    assert.equal(state.created, 0)
    assert.deepEqual(state.ids, ['existing'])
  }
})

test('busy admission releases only the new image and permits retry', () => {
  const { state, capture } = fixture()
  const add = capture()
  state.busy = true
  assert.throws(() => add({}), /busy/)
  assert.deepEqual(state.released, ['annotated'])
  assert.deepEqual(state.ids, ['existing'])
  state.busy = false
  add({})
  assert.deepEqual(state.ids, ['existing', 'annotated'])
})

test('annotation intake is absent without a current session or attachment service', () => {
  const { sessions, conversation } = fixture()
  assert.equal(captureImageInput(sessions, conversation, undefined, () => undefined), null)
  assert.equal(captureImageInput(sessions, undefined, 'one', () => 'one'), null)
})
