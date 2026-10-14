import test from 'node:test'
import assert from 'node:assert/strict'
import { completedReasoningReply } from '../src/client/reasoning-reply.js'
import { turnReasoning } from '../src/client/turn-reasoning.js'
import { workReplyText } from '../src/client/work-reply.js'

const step = (n, blocks, status = 'settled') => ({ turn: 1, step: n, status, blocks })
const reasoning = text => ({ kind: 'reasoning', text })
const completed = { turn: 1, end: { data: { reason: { kind: 'completed' } } }, steps: [{ step: 1 }] }

test('completed reasoning-only final reply appears once in body and copy text', () => {
  const steps = [step(1, [reasoning('Answer for the user')])]
  const fallback = completedReasoningReply(steps, completed)
  assert.deepEqual(fallback, { step: 1, text: 'Answer for the user' })
  assert.equal(turnReasoning(steps, steps[0], fallback.step), '')
  assert.equal(workReplyText(steps, fallback.text), 'Answer for the user')
})

test('only the final step is eligible while earlier thoughts and commentary remain intact', () => {
  const steps = [step(1, [reasoning('Earlier analysis'), { kind: 'text', text: 'Checking' }, { kind: 'tool-call' }]), step(2, [reasoning('Final reply')])]
  const fallback = completedReasoningReply(steps, { ...completed, steps: [{ step: 1 }, { step: 2 }] })
  assert.equal(fallback.step, 2)
  assert.equal(turnReasoning(steps, steps[0], fallback.step), 'Earlier analysis')
  assert.equal(workReplyText(steps, fallback.text), 'Checking\n\nFinal reply')
})

test('never promotes live, interrupted, failed, unknown, or incomplete turns', () => {
  const steps = [step(1, [reasoning('Thinking')])]
  for (const kind of ['interrupted', 'failed', 'cancelled']) {
    assert.equal(completedReasoningReply(steps, { ...completed, end: { data: { reason: { kind } } } }), undefined)
  }
  assert.equal(completedReasoningReply(steps, { turn: 1 }), undefined)
  assert.equal(completedReasoningReply(steps, undefined), undefined)
  assert.equal(completedReasoningReply(steps, { ...completed, steps: [{ step: 1 }, { step: 2 }] }), undefined)
  for (const status of ['running', 'interrupted']) {
    assert.equal(completedReasoningReply([step(1, [reasoning('Thinking')], status)], completed), undefined)
  }
})

test('regular answers, tool calls, images, empty reasoning, and other turns are unchanged', () => {
  for (const blocks of [
    [reasoning('Thinking'), { kind: 'text', text: 'Normal answer' }],
    [reasoning('Thinking'), { kind: 'tool-call' }],
    [reasoning('Thinking'), { kind: 'image' }],
    [reasoning('   ')],
  ]) assert.equal(completedReasoningReply([step(1, blocks)], completed), undefined)
  assert.equal(completedReasoningReply([{ ...step(1, [reasoning('Other turn')]), turn: 2 }], completed), undefined)
})
