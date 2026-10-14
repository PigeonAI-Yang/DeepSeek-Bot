import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageInspections } from '../src/client/image-inspections.js'
import { toolRecords, toolArgumentText, toolBatchStatus, toolRuns, activeToolRecords, activeReplyPeer } from '../src/client/tool-records.js'

const image = attachment => ({ type: 'image', attachment })
const result = (callId, name, args, content = [], over = {}) => ({
  kind: 'tool-result', callId, name, call: { name, argsRaw: JSON.stringify(args) }, content, ...over,
})
const running = (callId, name, args = {}, subCalls = [], over = {}) => ({
  phase: 'start', callId, name, argsRaw: JSON.stringify(args), subCalls, ...over,
})

test('uses the public preparing, running, completed, failed, and unknown states', () => {
  const preparing = { phase: 'preparing', callId: 'prep', name: 'read_file', argsRaw: '{"path":' }
  const records = toolRecords({
    phase: 'start', callId: 'parent', name: 'run_code', argsRaw: '{}', subCalls: [
      preparing,
      running('running', 'read_file', { path: 'src/app.js' }),
      result('done', 'write_file', { path: 'src/out.js' }, [{ type: 'text', text: 'Saved' }]),
      result('failed', 'write_file', {}, [], { error: 'disk full' }),
      { callId: 'unknown', name: 'inspect', argsRaw: '{}' },
    ],
  })

  assert.deepEqual(records.map(record => [record.name, record.status]), [
    ['run_code', 'running'], ['read_file', 'preparing'], ['read_file', 'running'],
    ['write_file', 'completed'], ['write_file', 'failed'], ['inspect', 'unclassified'],
  ])
  assert.deepEqual(records[1].args, {})
  assert.equal(records[2].object, 'src/app.js')
  assert.equal(records[3].output, 'Saved')
})

test('uses result name and call id when the optional call object is absent', () => {
  const orphan = { kind: 'tool-result', callId: 'orphan', name: 'search', call: null, argsRaw: '{"query":"cats"}', content: [
    { type: 'text', text: 'first line' }, image({ attachmentId: 'ignored' }), { type: 'text', text: 'second line' },
  ] }

  assert.deepEqual(toolRecords(orphan), [{
    key: 'call:orphan', callId: 'orphan', path: 'root', name: 'search', status: 'completed',
    object: 'cats', args: { query: 'cats' }, output: 'first line\nsecond line',
  }])
})

test('uses the first line of a known string argument and caps its header at 80 characters', () => {
  const path = `${'a'.repeat(90)}\nignored second line`
  const [record] = toolRecords(running('long', 'read_file', { path, other: 'not selected' }))

  assert.equal(record.object, `${'a'.repeat(79)}…`)
  assert.equal([...record.object].length, 80)
  assert.deepEqual(record.args, { path })
})

test('walks nested calls in preorder and gives missing ids a structural key', () => {
  const records = toolRecords(running('root', 'run_code', {}, [
    running(undefined, 'search', { q: 'one' }, [result('nested', 'read_file', { file_path: '/a' })]),
    result('last', 'write_file', { path: '/b' }),
  ]))

  assert.deepEqual(records.map(record => [record.name, record.key]), [
    ['run_code', 'call:root'],
    ['search', 'call:root.subCalls.0'],
    ['read_file', 'call:nested'],
    ['write_file', 'call:last'],
  ])
})

test('omits dedicated DS Bot tools and their entire subcall trees', () => {
  const dedicated = [
    'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group',
    'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret',
    'ask_user_question', 'read_group_chat', 'remember', 'forget',
  ]
  const records = toolRecords(running('parent', 'run_code', {}, [
    ...dedicated.map((name, index) => running(`private-${index}`, name, { code: 'private args' }, [
      result(`nested-${index}`, 'read_file', { path: 'private child' }, [{ type: 'text', text: 'private output' }]),
    ])),
    result('visible', 'read_file', { path: 'public.txt' }),
  ]))

  assert.deepEqual(records.map(record => record.callId), ['visible'])
  assert.doesNotMatch(JSON.stringify(records), /private args|private child|private output/)
})

test('redacts sensitive keys in selected nested args and exposes text blocks only', () => {
  const [record] = toolRecords(result('query', 'search', {
    query: { term: 'birds', api_key: 'secret-value', nested: { authorization: 'bearer-value' } },
    metadata: { secret: 'not selected' },
  }, [
    { type: 'text', text: 'Search completed' },
    image({ attachmentId: 'image-not-text' }),
  ]))

  assert.deepEqual(record.args, { query: { term: 'birds', api_key: '[redacted]', nested: { authorization: '[redacted]' } } })
  assert.equal(record.object, undefined)
  assert.equal(record.output, 'Search completed')
  assert.doesNotMatch(JSON.stringify(record), /secret-value|bearer-value|not selected|image-not-text/)
})

test('keeps pending, failed, and image-free read_image records while omitting an existing image card call', () => {
  const attachment = { attachmentId: 'visible-image', name: 'visible.png', mediaType: 'image/png' }
  const root = running('parent', 'run_code', {}, [
    { ...running('pending', 'read_image', { path: '/pending.png' }), content: [image(attachment)] },
    result('failed', 'read_image', { path: '/failed.png' }, [image(attachment)], { isError: true }),
    result('no-image', 'read_image', { path: '/empty.png' }, [{ type: 'text', text: 'No image' }]),
    result('actual-image', 'read_image', { file_path: '/visible.png' }, [image(attachment)]),
  ])

  assert.deepEqual(toolRecords(root).map(record => [record.callId, record.status]), [
    ['parent', 'running'], ['pending', 'running'], ['failed', 'failed'], ['no-image', 'completed'],
  ])
  assert.deepEqual(imageInspections(root).map(item => item.key), ['actual-image:0'])
})

test('preserves real command newlines, literal escapes, and Windows paths', () => {
  const command = 'cd J:\\work\n  Write-Host "one"\n  Write-Host "\\n"'
  assert.equal(toolArgumentText(command), command)
  assert.equal(toolArgumentText({ a: [1, false] }), JSON.stringify({ a: [1, false] }, null, 2))
})

test('batch status reflects failure and outstanding work before completion', () => {
  const records = (...statuses) => statuses.map(status => ({ status }))
  assert.equal(toolBatchStatus(records('completed', 'running')), 'running')
  assert.equal(toolBatchStatus(records('failed', 'running')), 'failed')
  assert.equal(toolBatchStatus(records('completed', 'preparing')), 'preparing')
  assert.equal(toolBatchStatus(records('completed', 'completed')), 'completed')
  assert.equal(toolBatchStatus(records('completed', 'unclassified')), 'unclassified')
})

const toolNode = (seq, root, turn = 1) => ({ key: `tool:${seq}`, kind: 'tool-call', anchorSeq: seq, location: { turn: { turn } }, data: { root } })
const assistantNode = (seq, blocks, turn = 1) => ({ key: `assistant:${seq}`, kind: 'assistant-step', anchorSeq: seq, data: { turn, blocks } })
const snapshot = nodes => ({ nodes: { values: () => nodes.values() } })

test('groups a chain across reasoning-only steps and keeps every call exactly once', () => {
  const nodes = [toolNode(2, result('a', 'read_file', { path: 'a' })),
    assistantNode(3, [{ kind: 'reasoning', text: 'Next check' }]),
    toolNode(4, running('b', 'pwsh', { command: 'Get-Item a' }))]
  const runs = toolRuns(snapshot(nodes.reverse()))
  assert.deepEqual(runs.get('tool:2').records.map(record => record.callId), ['a', 'b'])
  assert.equal(runs.get('tool:2').hidden, false)
  assert.equal(runs.get('tool:4').hidden, true)
  assert.equal(toolBatchStatus(runs.get('tool:2').records), 'running')
})

test('user steering, assistant replies, dedicated tools, and turn boundaries separate batches', () => {
  const barriers = [
    { key: 'user', kind: 'steering', anchorSeq: 3, data: { turn: 1 } },
    assistantNode(3, [{ kind: 'text', text: 'Progress for the user' }]),
    toolNode(3, result('ask', 'ask_user', {})),
    { key: 'context', kind: 'context', anchorSeq: 3, data: { turn: 1 } },
  ]
  for (const barrier of barriers) {
    const runs = toolRuns(snapshot([toolNode(2, result('a', 'read_file', {})), barrier, toolNode(4, result('b', 'write_file', {}))]))
    assert.equal(runs.get('tool:2').records.length, 1)
    assert.equal(runs.get('tool:4').hidden, false)
  }
  const runs = toolRuns(snapshot([toolNode(2, result('a', 'read_file', {})), toolNode(4, result('b', 'read_file', {}), 2)]))
  assert.equal(runs.get('tool:4').hidden, false)
})

test('image previews stay visible and separate adjacent tool batches', () => {
  const imageNode = toolNode(3, result('image', 'read_image', {}, [image({ attachmentId: 'image', name: 'a.png' })]))
  const runs = toolRuns(snapshot([toolNode(2, result('a', 'read_file', {})), imageNode, toolNode(4, result('b', 'read_file', {}))]))
  assert.equal(runs.has(imageNode.key), false)
  assert.equal(runs.get('tool:4').hidden, false)
})

test('active tools come from loaded nodes independently of mounted or merged transcript cells', () => {
  const root = { ...running('a', 'run_code', {}, [
    { ...running('b', 'pwsh', { command: 'python run_image.py' }), time: 2000 },
    result('done', 'read_file', { path: 'done' }),
  ]), time: 1000 }
  const node = { ...toolNode(2, root), visibility: 'hidden' }
  const active = activeToolRecords(snapshot([node]))
  assert.deepEqual(active.map(record => [record.callId, record.at]), [['a', 1000], ['b', 2000]])
  assert.equal(active[1].object, 'python run_image.py')
  root.subCalls[0] = result('b', 'pwsh', {})
  assert.equal(activeToolRecords(snapshot([node])).length, 1)
})

test('active status respects private subtrees and preparing calls without arguments', () => {
  const node = toolNode(2, running('root', 'run_code', {}, [running('private', 'request_secret', {}, [running('child', 'pwsh', { command: 'private' })]), { phase: 'preparing', name: 'read_file', callId: 'prep', time: 3000 }]))
  const active = activeToolRecords(snapshot([node]))
  assert.deepEqual(active.map(record => record.callId), ['root', 'prep'])
  assert.deepEqual(active[1].args, {})
})

test('only an open Bot request reports a reply peer, and completion clears it', () => {
  const node = { key: 'request', kind: 'turn-trigger', anchorSeq: 20, location: { turn: { status: 'open' } }, data: { source: { kind: 'bot', role: 'request', senderSessionId: 'other', senderName: 'Other' } } }
  assert.deepEqual(activeReplyPeer(snapshot([node])), { id: 'other', name: 'Other', seq: 20 })
  node.location.turn.status = 'closed'
  assert.equal(activeReplyPeer(snapshot([node])), undefined)
  node.location.turn.status = 'open'; node.data.source.kind = 'user'
  assert.equal(activeReplyPeer(snapshot([node])), undefined)
})

test('one continuous work batch spans native request headers and hidden per-step bookkeeping', () => {
  const nodes = [toolNode(1, result('first', 'list_bots', {}))]
  for (let step = 1; step <= 39; step++) {
    const seq = step * 10
    nodes.push({ key: `request:${step}`, kind: 'request-prompt', anchorSeq: seq, location: { turn: { turn: 1 } }, data: {} })
    nodes.push({ key: `system:${step}`, kind: 'system-prompt', anchorSeq: seq + 1, visibility: 'hidden', data: {} })
    nodes.push(assistantNode(seq + 2, [{ kind: 'reasoning', text: 'Internal check' }, { kind: 'tool-call', callId: `call:${step}` }]))
    nodes.push(toolNode(seq + 3, result(`call:${step}`, step % 2 ? 'pwsh' : 'job_output', {})))
  }
  const runs = toolRuns(snapshot(nodes))
  assert.equal([...runs.values()].filter(run => !run.hidden).length, 1)
  assert.equal(runs.get('tool:1').records.length, 40)
  assert.equal(new Set(runs.get('tool:1').records.map(record => record.callId)).size, 40)
})

test('a PTC card is a batch boundary and its ordinary subcalls remain unique', () => {
  const read = result('read', 'read_file', { path: 'public.txt' })
  const root = running('program', 'run_code', {}, [read, running('ask', 'ask_user', {}), read])
  const cardNode = toolNode(2, root)
  const runs = toolRuns(snapshot([toolNode(1, result('before', 'pwsh', {})), cardNode, toolNode(3, result('after', 'pwsh', {}))]))
  assert.equal(runs.has(cardNode.key), false)
  assert.equal(runs.get('tool:3').hidden, false)
  assert.deepEqual(toolRecords(root).map(record => record.callId), ['read'])
})
