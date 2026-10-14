import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageInspections } from '../src/client/image-inspections.js'

const image = attachment => ({ type: 'image', attachment })

function result(callId, name, args, content, { isError = false, subCalls = [] } = {}) {
  return {
    kind: 'tool-result',
    callId,
    call: { name, argsRaw: JSON.stringify(args) },
    content,
    isError,
    subCalls,
  }
}

function running(callId, name, subCalls = []) {
  return { phase: 'start', callId, name, argsRaw: '{}', subCalls }
}

test('collects root read_image attachments in content order with their original references', () => {
  const named = { attachmentId: 'one', mediaType: 'image/png', name: 'display.png', width: 640, height: 480 }
  const fallbackName = { attachmentId: 'two', mediaType: 'image/png' }
  const root = result('root-call', 'read_image', { file_path: 'C:\\images\\source.png' }, [
    { type: 'text', text: 'Loaded' },
    image(named),
    image(fallbackName),
  ])

  const inspections = imageInspections(root)

  assert.deepEqual(inspections.map(item => [item.key, item.label]), [
    ['root-call:0', 'display.png'],
    ['root-call:1', 'source.png'],
  ])
  assert.strictEqual(inspections[0].attachment, named)
  assert.strictEqual(inspections[1].attachment, fallbackName)
})

test('collects completed read_image subcalls under a running parent and nested children', () => {
  const firstAttachment = { attachmentId: 'first', mediaType: 'image/webp', name: 'first.webp' }
  const secondAttachment = { attachmentId: 'second', mediaType: 'image/png', name: 'second.png' }
  const first = result('first-read', 'read_image', {}, [image(firstAttachment)])
  const second = result('second-read', 'read_image', {}, [image(secondAttachment)])
  const root = running('running-code', 'run_code', [
    first,
    running('nested-run', 'helper', [second]),
  ])

  const inspections = imageInspections(root)

  assert.deepEqual(inspections.map(item => [item.key, item.label]), [
    ['first-read:0', 'first.webp'],
    ['second-read:0', 'second.png'],
  ])
  assert.strictEqual(inspections[0].attachment, firstAttachment)
  assert.strictEqual(inspections[1].attachment, secondAttachment)
})

test('ignores failed, pending, unrelated, and image-free tool calls', () => {
  const attachment = { attachmentId: 'ignored', mediaType: 'image/png', name: 'ignored.png' }
  const root = result('container', 'run_code', {}, [], {
    subCalls: [
      result('failed', 'read_image', {}, [image(attachment)], { isError: true }),
      { ...running('pending', 'read_image'), content: [image(attachment)] },
      result('other-tool', 'inspect', {}, [image(attachment)]),
      result('no-image', 'read_image', {}, [{ type: 'text', text: 'No image returned' }]),
    ],
  })

  assert.deepEqual(imageInspections(root), [])
})

test('keeps separate call keys for repeated attachments and preserves multiple image order', () => {
  const repeated = { attachmentId: 'same', mediaType: 'image/png', name: 'same.png' }
  const second = { attachmentId: 'second', mediaType: 'image/png', name: 'second.png' }
  const root = result('parent', 'run_code', {}, [], {
    subCalls: [
      result('read-one', 'read_image', {}, [image(repeated), image(second)]),
      result('read-two', 'read_image', {}, [image(repeated)]),
    ],
  })

  const inspections = imageInspections(root)

  assert.deepEqual(inspections.map(item => item.key), ['read-one:0', 'read-one:1', 'read-two:0'])
  assert.deepEqual(inspections.map(item => item.label), ['same.png', 'second.png', 'same.png'])
  assert.strictEqual(inspections[0].attachment, repeated)
  assert.strictEqual(inspections[1].attachment, second)
  assert.strictEqual(inspections[2].attachment, repeated)
})
