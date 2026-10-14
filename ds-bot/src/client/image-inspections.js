import { toolArgs, toolName } from './text.js'

function fileName(path) {
  if (typeof path !== 'string') return undefined
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || undefined
}

export function imageInspections(root) {
  const inspections = []
  const visit = call => {
    if (!call || typeof call !== 'object') return
    if (call.kind === 'tool-result' && !call.isError && toolName(call) === 'read_image' && typeof call.callId === 'string') {
      const path = toolArgs(call).text('file_path')
      let imageIndex = 0
      for (const block of Array.isArray(call.content) ? call.content : []) {
        if (block?.type !== 'image' || !block.attachment || typeof block.attachment !== 'object') continue
        inspections.push({
          key: `${call.callId}:${imageIndex++}`,
          attachment: block.attachment,
          label: typeof block.attachment.name === 'string' && block.attachment.name ? block.attachment.name : fileName(path),
        })
      }
    }
    for (const child of Array.isArray(call.subCalls) ? call.subCalls : []) visit(child)
  }
  visit(root)
  return inspections
}
