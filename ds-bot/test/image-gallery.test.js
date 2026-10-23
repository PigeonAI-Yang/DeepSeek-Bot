import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationImages, earlierImagePage, imageGallery } from '../src/client/image-gallery.js'

test('gallery collects user, steering, assistant and tool images from loaded history in conversation order', () => {
  const input = { attachmentId: 'input', mediaType: 'image/png', name: 'input.png' }
  const tool = { attachmentId: 'tool', mediaType: 'image/png', name: 'detail.png' }
  const nodes = [
    { key: 'reply', kind: 'assistant-step', anchorSeq: 8, visibility: 'hidden', data: { blocks: [{ kind: 'text', text: '![result](./result.png)' }] } },
    { key: 'upload', kind: 'user', anchorSeq: 1, data: { content: [{ type: 'image', attachment: input }] } },
    { key: 'steer', kind: 'steering', anchorSeq: 3, data: { content: [{ type: 'image', attachment: { ...input, attachmentId: 'steer', name: 'steer.png' } }] } },
    { key: 'tool', kind: 'tool-call', anchorSeq: 5, data: { root: { kind: 'tool-result', callId: 'read', call: { name: 'read_image', argsRaw: '{"file_path":"detail.png"}' }, content: [{ type: 'image', attachment: tool }] } } },
  ]
  const images = conversationImages({ nodes: new Map(nodes.map(node => [node.key, node])) }, { cwd: 'J:/work', base: 'dsh-app://app/', peekImage: attachment => attachment === input ? 'blob:input' : undefined })
  assert.deepEqual(images.map(image => image.name), ['input.png', 'steer.png', 'detail.png', 'result'])
  assert.deepEqual(images.map(image => image.seq), [1, 3, 5, 8])
  assert.equal(images[0].src, 'blob:input')
  assert.equal(images[1].src, undefined)
  assert.equal(new URL(images[2].src).searchParams.get('path'), 'J:/work/detail.png')
  assert.equal(new URL(images[3].src).searchParams.get('path'), 'J:/work/result.png')
})

test('gallery matches native file URLs across Windows separators and keeps one entry for repeated rendered images', () => {
  const items = [{ key: 'path:j:/work/one.png', src: 'dsh-app://app/api/file?path=J%3A%2Fwork%2Fone.png', name: 'one' }, { key: 'two', src: 'blob:two', name: 'two' }]
  const current = { src: 'dsh-app://app/api/file?path=J%3A%5Cwork%5Cone.png', name: 'one.png' }
  const result = imageGallery(items, current, [current, { src: 'blob:two' }])
  assert.equal(result.images.length, 2)
  assert.equal(result.index, 0)
  assert.equal(result.images[0].name, 'one.png')
})

test('gallery deduplicates unmounted attachment references without loading image bytes', () => {
  const attachment = { attachmentId: 'same', variant: 'full' }
  const result = imageGallery([{ key: 'tool', attachment }, { key: 'user', attachment }], { key: 'tool', src: 'blob:opened', name: 'opened.png' })
  assert.equal(result.images.length, 1)
  assert.equal(result.index, 0)
  assert.equal(result.images[0].src, 'blob:opened')
})

test('an image outside the snapshot remains previewable and empty history stays bounded', () => {
  const image = { src: 'https://example.test/picture.png', name: 'picture.png' }
  assert.deepEqual(conversationImages(undefined), [])
  assert.deepEqual(imageGallery([], image), { images: [image], index: 0 })
})

test('earlier image paging follows the Session history cursor and rereads the chat snapshot', async () => {
  let seq = 100
  const items = [{ key: 'old', src: 'blob:old' }]
  const binding = {
    eventSource: { getSnapshot: () => ({ entries: [{ type: 'event', event: { seq } }] }) },
    session: { loadOlder: async () => { seq = 10 }, getSnapshot: () => ({ hasMore: true }) },
  }
  assert.deepEqual(await earlierImagePage(binding, () => true, () => items), { items, hasMore: true })
  binding.session.loadOlder = async () => {}
  await assert.rejects(earlierImagePage(binding, () => true, () => items), /did not advance/)
  binding.session.getSnapshot = () => ({ hasMore: false })
  assert.deepEqual(await earlierImagePage(binding, () => true, () => items), { items, hasMore: false })
})

test('earlier image paging refuses stale session bindings before and after the asynchronous request', async () => {
  let active = false
  let calls = 0
  const binding = {
    eventSource: { getSnapshot: () => ({ entries: [] }) },
    session: { loadOlder: async () => { calls += 1; active = false }, getSnapshot: () => ({ hasMore: false }) },
  }
  await assert.rejects(earlierImagePage(binding, () => active, () => []), /no longer available/)
  assert.equal(calls, 0)
  active = true
  await assert.rejects(earlierImagePage(binding, () => active, () => []), /no longer available/)
  assert.equal(calls, 1)
})
