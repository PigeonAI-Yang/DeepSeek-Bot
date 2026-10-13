import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workReplyText } from '../src/client/work-reply.js'

test('joins non-empty text blocks in assistant-step order and excludes other block kinds', () => {
  const steps = [
    { blocks: [
      { kind: 'reasoning', text: 'Private reasoning' },
      { kind: 'text', text: 'First paragraph' },
      { kind: 'tool-call', name: 'search', argsRaw: '{"q":"secret"}' },
      { kind: 'text', text: 'Second paragraph' },
      { kind: 'text', text: '  ' },
    ] },
    { blocks: [
      { kind: 'tool-result', content: [{ type: 'text', text: 'Tool output' }] },
      { kind: 'text', text: 'Final answer' },
    ] },
  ]

  assert.equal(workReplyText(steps), 'First paragraph\n\nSecond paragraph\n\nFinal answer')
})

test('includes every loaded step instead of truncating an old turn', () => {
  const steps = Array.from({ length: 12 }, (_, index) => ({ blocks: [{ kind: 'text', text: `Progress ${index + 1}` }] }))

  assert.equal(workReplyText(steps), Array.from({ length: 12 }, (_, index) => `Progress ${index + 1}`).join('\n\n'))
})

test('uses only the steps supplied for each turn and retains source Markdown verbatim', () => {
  const olderTurn = [{ blocks: [{ kind: 'text', text: 'Earlier turn' }] }]
  const currentTurn = [{ blocks: [{ kind: 'text', text: String.raw`![stairs](C:\Users\Bot\workspace\stairs.png)` }] }]

  assert.equal(workReplyText(olderTurn), 'Earlier turn')
  assert.equal(workReplyText(currentTurn), String.raw`![stairs](C:\Users\Bot\workspace\stairs.png)`)
})

test('returns an empty reply when there are no non-empty assistant text blocks', () => {
  assert.equal(workReplyText(undefined), '')
  assert.equal(workReplyText([
    { blocks: [{ kind: 'reasoning', text: 'Thinking' }, { kind: 'tool-call', name: 'read' }, { kind: 'text', text: ' \n ' }] },
  ]), '')
})
