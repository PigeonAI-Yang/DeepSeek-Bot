const SINGLE_HEADER = '[SCHEDULE REMINDER]'
const BATCH_HEADER = '[SCHEDULE REMINDER BATCH]'
const FRAMING = 'This is a scheduled message from the user'

const jsonField = (text, name) => {
  const matches = [...text.matchAll(new RegExp('^' + name + ': (.*)$', 'gm'))]
  if (matches.length !== 1) return undefined
  try {
    return JSON.parse(matches[0][1])
  } catch {
    return undefined
  }
}

const validReminder = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof value.schedule_id === 'string' && value.schedule_id !== ''
  && typeof value.occurrence_at === 'string' && value.occurrence_at !== ''
  && typeof value.reminder_prompt === 'string'

export function parseScheduleInput(text) {
  if (typeof text !== 'string' || !text.includes(FRAMING)) return { recognized: false }
  if (text.startsWith(SINGLE_HEADER + '\n')) {
    const scheduleId = jsonField(text, 'schedule_id_json')
    const occurrenceAt = /^occurrence_at: (.+)$/m.exec(text)?.[1]
    const prompt = jsonField(text, 'reminder_prompt_json')
    if (typeof scheduleId !== 'string' || scheduleId === '' || typeof occurrenceAt !== 'string' || occurrenceAt === '' || typeof prompt !== 'string') {
      return { recognized: false }
    }
    return { recognized: true, kind: 'single', entries: [{ scheduleId, occurrenceAt, prompt }] }
  }
  if (text.startsWith(BATCH_HEADER + '\n')) {
    const payload = jsonField(text, 'reminders_json')
    if (!Array.isArray(payload)) return { recognized: false }
    return {
      recognized: true,
      kind: 'batch',
      entries: payload.map(raw => validReminder(raw)
        ? { raw, scheduleId: raw.schedule_id, occurrenceAt: raw.occurrence_at, prompt: raw.reminder_prompt }
        : { raw }),
    }
  }
  return { recognized: false }
}

export function renderRemainingScheduleInput(text, kind, entries) {
  if (entries.length === 0) return ''
  if (kind === 'single') return text
  const lines = text.split('\n')
  const marker = lines.findIndex(line => line.startsWith('reminders_json: '))
  if (marker < 0) return text
  const payload = entries.map(entry => entry.raw ?? ({
    schedule_id: entry.scheduleId,
    occurrence_at: entry.occurrenceAt,
    reminder_prompt: entry.prompt,
  }))
  lines[marker] = 'reminders_json: ' + JSON.stringify(payload)
  return lines.join('\n')
}

export function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function replaceMessageText(message, text) {
  if (text === '') return undefined
  const blocks = Array.isArray(message?.content) ? message.content : []
  let replaced = false
  const content = blocks.map(block => {
    if (block?.type !== 'text' || replaced) return block
    replaced = true
    return { ...block, text }
  })
  if (!replaced) content.push({ type: 'text', text })
  return { ...message, content }
}
