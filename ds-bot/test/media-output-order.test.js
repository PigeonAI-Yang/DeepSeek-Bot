import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeMediaOutputs } from '../src/client/media.js'

test('a completed Comfy result appears first without a new assistant message', () => {
  const chat = [{ key: 'old-presented-image', seq: 9000 }]
  const artifacts = [{ artifactId: 'older', createdAt: 1000 }, { artifactId: 'newest', createdAt: 2000 }]
  const result = mergeMediaOutputs(chat, artifacts, { newestFirst: true })
  assert.deepEqual(result.map(item => item.artifactId ?? item.key), ['newest', 'older', 'old-presented-image'])
  assert.equal(chat.length, 1)
  assert.equal(artifacts[0].artifactId, 'older')
})

test('presenting the same artifact later does not duplicate it or drop its media controls', () => {
  const generated = { artifactId: 'result-1', createdAt: 2000, canReview: true }
  const result = mergeMediaOutputs([{ artifactId: 'result-1', key: 'chat-result' }], [generated], { newestFirst: true })
  assert.equal(result.length, 1)
  assert.equal(result[0], generated)
})

test('the image gallery keeps its existing transcript order', () => {
  const chat = [{ key: 'first' }, { key: 'second' }]
  assert.deepEqual(mergeMediaOutputs(chat, [{ key: 'generated' }]).map(item => item.key), ['first', 'second', 'generated'])
})
