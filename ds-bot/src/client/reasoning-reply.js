// Some providers end a turn with only reasoning content. Present that final
// message at the turn tail without reclassifying live or intermediate thoughts.
export function completedReasoningReply(steps, turn) {
  if (turn?.end?.data?.reason?.kind !== 'completed') return undefined
  const members = steps.filter(step => step.turn === turn.turn)
  const last = members.reduce((latest, step) => !latest || step.step > latest.step ? step : latest, undefined)
  if (!last || !['settled', 'done'].includes(last.status)) return undefined
  if (turn.steps?.some(step => step.step > last.step)) return undefined
  if (last.blocks.some(block => block.kind !== 'reasoning' && !(block.kind === 'text' && !block.text.trim()))) return undefined
  const text = last.blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('\n').trim()
  return text ? { step: last.step, text } : undefined
}
