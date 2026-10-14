export function workReplyText(steps, fallback = '') {
  if (!Array.isArray(steps)) return ''
  const texts = []
  for (const step of steps) {
    const blocks = Array.isArray(step?.blocks) ? step.blocks : []
    for (const block of blocks) {
      if (block?.kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text)
    }
  }
  if (fallback) texts.push(fallback)
  return texts.join('\n\n')
}
