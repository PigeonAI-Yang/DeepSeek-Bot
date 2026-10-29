import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownOutputLinks } from '../src/client/text.js'
import { outputItems } from '../src/client/output-items.js'

const image = attachment => ({ type: 'image', attachment })

function result(callId, name, args, content = [], { isError = false, error, subCalls = [] } = {}) {
  return {
    kind: 'tool-result', callId, call: { name, argsRaw: JSON.stringify(args) }, content,
    isError, error, subCalls,
  }
}

function snapshot(nodes) {
  return { nodes: new Map(nodes.map((node, index) => [String(index), node])) }
}

function assistant(anchorSeq, blocks) {
  return { kind: 'assistant-step', anchorSeq, data: { blocks } }
}

function toolNode(anchorSeq, root) {
  return { kind: 'tool-call', anchorSeq, data: { root } }
}

test('extracts authored local Markdown links outside code and ignores URL destinations', () => {
  const source = [
    String.raw`[report](<C:\work\reports\summary.pdf#L3>)`,
    String.raw`![chart](images\chart.webp)`,
    '[remote](https://example.test/chart.png)',
    '[resource](file:///C:/work/image.png)',
    '[bot](https://bots.local/session)',
    '[local bot](bots.local/output.pdf)',
    '[script](javascript:alert(1))',
    '`[inline](./inline.txt)`',
    '````md',
    '[fenced](./fenced.png)',
    '```',
    '[still fenced](./still-fenced.png)',
    '````',
    'cat /tmp/not-a-link.png',
  ].join('\n')

  assert.deepEqual(markdownOutputLinks(source), [
    { label: 'report', destination: 'C:/work/reports/summary.pdf' },
    { label: 'chart', destination: 'images/chart.webp' },
  ])
})

test('collects hidden materialized assistant nodes, read_image attachments, writes, and live links newest first', () => {
  const picture = { attachmentId: 'plot-1', mediaType: 'image/png', name: 'plot.png', width: 320, height: 200 }
  const older = assistant(2, [{ kind: 'text', text: '[old image](./old/preview.jpg)' }])
  const tools = toolNode(8, result('batch', 'run_code', {}, [], {
    subCalls: [
      result('read-plot', 'read_image', { file_path: 'C:\\work\\plots\\plot.png' }, [image(picture)]),
      result('saved-table', 'write_file', { file_path: 'C:\\work\\exports\\table.csv' }),
    ],
  }))
  const latest = assistant(10, [{ kind: 'text', text: '[notes](./notes/final.pdf)' }])

  assert.deepEqual(outputItems(snapshot([older, tools, latest])).map(item => [item.name, item.kind, item.path]), [
    ['notes', 'file', './notes/final.pdf'],
    ['plot.png', 'image', 'C:/work/plots/plot.png'],
    ['table.csv', 'file', 'C:/work/exports/table.csv'],
    ['old image', 'image', './old/preview.jpg'],
  ])
  const loaded = outputItems(snapshot([older, tools, latest]))
  assert.strictEqual(loaded[1].attachment, picture)
})

test('deduplicates normalized Windows paths, merges read_image thumbnails, and keeps equal basenames apart', () => {
  const picture = { attachmentId: 'chart-1', mediaType: 'image/png', name: 'status.png' }
  const pathFromTool = toolNode(7, result('read-chart', 'read_image', { file_path: 'c:/Outputs/charts/status.png' }, [image(picture)]))
  const links = assistant(6, [{ kind: 'text', text: [
    String.raw`[diagram](<C:\outputs\charts\status.png#L2>)`,
    '[other status](./notes/status.png)',
  ].join(' '),
  }])
  const items = outputItems(snapshot([links, pathFromTool]))

  assert.equal(items.length, 2)
  assert.equal(items[0].name, 'diagram')
  assert.equal(items[0].kind, 'image')
  assert.strictEqual(items[0].attachment, picture)
  assert.equal(items[0].path, 'c:/Outputs/charts/status.png')
  assert.equal(items[1].name, 'other status')
  assert.equal(items[1].path, './notes/status.png')
})

test('deduplicates an assistant image attachment with its read_image path', () => {
  const picture = { attachmentId: 'chart-2', mediaType: 'image/png', name: 'chart.png' }
  const direct = assistant(9, [image(picture)])
  const read = toolNode(7, result('read-chart', 'read_image', { file_path: 'C:\\work\\images\\chart.png' }, [image(picture)]))
  const items = outputItems(snapshot([direct, read]))

  assert.equal(items.length, 1)
  assert.equal(items[0].path, 'C:/work/images/chart.png')
  assert.strictEqual(items[0].attachment, picture)
})

test('resolves Markdown paths against the session cwd while keeping same-name files apart', () => {
  const picture = { attachmentId: 'status-1', mediaType: 'image/png', name: 'status.png' }
  const links = assistant(10, [{ kind: 'text', text: [
    '[status chart](./outputs/status.png)',
    '[archived status](./archive/status.png)',
  ].join(' ') }])
  const read = toolNode(8, result('read-status', 'read_image', { file_path: 'C:\\work\\project\\outputs\\status.png' }, [image(picture)]))
  const items = outputItems(snapshot([links, read]), { cwd: 'C:\\work\\project' })

  assert.equal(items.length, 2)
  assert.deepEqual(items.map(item => [item.name, item.path]), [
    ['status chart', 'C:/work/project/outputs/status.png'],
    ['archived status', 'C:/work/project/archive/status.png'],
  ])
  assert.strictEqual(items[0].attachment, picture)
})

test('excludes user/context/code links, external paths, failed results, and pending writes', () => {
  const ignored = { attachmentId: 'ignored', mediaType: 'image/png', name: 'ignored.png' }
  const eligibleNestedWrite = result('nested-save', 'write_file', { path: './kept/readme.md' })
  const pending = {
    phase: 'start', name: 'write_file', argsRaw: JSON.stringify({ file_path: './pending/file.txt' }),
  }
  const nodes = [
    assistant(4, [{ kind: 'text', text: [
      '[kept](./kept/notes.txt)',
      '[external](//example.test/image.png)',
      '[bot](bots.local/image.png)',
      '[bad](data:image/png;base64,abc)',
      '`[code](./inline.png)`',
      '```sh\n[command](./command.png)\n```',
      'printf ./plain-prose.png',
    ].join('\n') }]),
    { kind: 'user', anchorSeq: 8, data: { content: [{ type: 'text', text: '[user](./user.pdf)' }] } },
    { kind: 'context', anchorSeq: 9, data: { blocks: [{ kind: 'text', text: '[context](./context.pdf)' }] } },
    toolNode(10, result('failed-write', 'write_file', { file_path: './failed/no.txt' }, [], { isError: true })),
    toolNode(11, {
      phase: 'start', name: 'run_code', argsRaw: '{}', subCalls: [
        result('failed-read', 'read_image', { file_path: './failed/no.png' }, [image(ignored)], { error: 'failed' }),
        pending,
        eligibleNestedWrite,
      ],
    }),
    toolNode(12, result('external-read', 'read_image', { file_path: 'https://example.test/image.png' }, [image(ignored)])),
  ]

  assert.deepEqual(outputItems(snapshot(nodes)).map(item => item.path), ['./kept/readme.md', './kept/notes.txt'])
})

test('recomputes from the updated snapshot without exhausting unloaded history', () => {
  const before = snapshot([assistant(2, [{ kind: 'text', text: '[first](./first.txt)' }])])
  const after = snapshot([
    assistant(2, [{ kind: 'text', text: '[first](./first.txt)' }]),
    assistant(5, [{ kind: 'text', text: '[second](./second.txt)' }]),
  ])

  assert.deepEqual(outputItems(before).map(item => item.path), ['./first.txt'])
  assert.deepEqual(outputItems(after).map(item => item.path), ['./second.txt', './first.txt'])
})

// The host appends `image/offload` for old images so they are no longer re-sent to
// the model. The attachment survives on the tool result, so the outputs card must
// still list it: offloading is not deletion.
test('lists images from tool results the host has offloaded', () => {
  const kept = { attachmentId: 'sha256:kept', mediaType: 'image/webp', name: 'leggings1_00001_.png' }
  const generated = { attachmentId: 'sha256:generated', mediaType: 'image/png', name: 'render.png' }
  const nodes = [
    toolNode(125, result('call-read', 'read_image', { file_path: 'C:/out/leggings1_00001_.png' }, [image(kept)])),
    toolNode(126, result('call-generate', 'run_code', { code: 'draw()' }, [image(generated)])),
  ]

  const items = outputItems(snapshot(nodes))
  assert.deepEqual(items.map(item => item.name).sort(), ['leggings1_00001_.png', 'render.png'])
  assert.deepEqual(items.map(item => item.kind), ['image', 'image'])
  assert.strictEqual(items[0].attachment?.attachmentId, 'sha256:generated')
})

// A failed tool call produced no output, so its image must not reach the card.
test('ignores images on failed tool results', () => {
  const ignored = { attachmentId: 'sha256:ignored', mediaType: 'image/png', name: 'ignored.png' }
  const nodes = [
    toolNode(20, result('call-failed', 'run_code', {}, [image(ignored)], { isError: true })),
    toolNode(21, result('call-error', 'run_code', {}, [image(ignored)], { error: 'boom' })),
  ]

  assert.deepEqual(outputItems(snapshot(nodes)), [])
})
