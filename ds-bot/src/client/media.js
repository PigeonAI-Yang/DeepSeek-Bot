export function captureMediaDraft(sessions, conversation, sessionId, shownSession) {
  const binding = sessions.binding(sessionId)
  if (!binding || !conversation?.createDrafts || !conversation?.input) return null
  const input = conversation.input.for(binding.ctx)
  const revision = input.state.getSnapshot().draftRev
  const check = () => {
    if (sessions.binding(sessionId) !== binding || shownSession() !== sessionId) throw new Error('Return to the original conversation to add the edit request.')
    if (input.state.getSnapshot().draftRev !== revision) throw new Error('The draft changed. Reopen the image to add this request.')
  }
  return {
    check,
    stage(files, text) {
      check()
      const drafts = conversation.createDrafts(sessionId, files)
      try {
        check()
        if (!input.addAttachments(drafts.map(draft => draft.id))) throw new Error('The input is busy. Please try again.')
        const state = input.state.getSnapshot()
        const end = state.draft.length
        if (!input.actions.insertText(`${end ? '\n' : ''}${text}`, { start: end, end, draftRev: state.draftRev })) throw new Error('The input changed while adding the request.')
      } catch (error) {
        for (const draft of drafts) input.removeAttachment(draft.id)
        conversation.releaseDraftAttachments(drafts)
        throw error
      }
      input.focus()
    },
  }
}

export function mergeMediaOutputs(transcript, artifacts) {
  const seen = new Set(transcript.map(item => item.artifactId ?? item.key))
  return [...transcript, ...artifacts.filter(item => {
    const key = item.artifactId ?? item.key
    if (seen.has(key)) return false
    seen.add(key); return true
  })]
}
