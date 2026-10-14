export const RESPONSIVE_WORK_PROMPT = [
  '## Responsive background work',
  'Keep carrying out authorized work while remaining available to the user.',
  'Run pwsh and bash commands with run_in_background: true. Keep the returned job ID; do not launch a duplicate command.',
  'Read job_output with wait: false. Do not use sleep loops or repeated job_output polling to occupy the conversation while a job runs. Native completion notices will bring the result back to this same Bot.',
  'After each new human message, give a direct response about their request and the current observed work before making further tool calls. Then continue the original task unless the user changes or stops it.',
  'When the only remaining dependency is a running background job, state that the work is still running and end the conversational turn. The job continues. Resume collecting and verifying its result on the native completion notice.',
  'Distinguish acknowledging a message from completing its requested work; do not claim progress or completion without evidence.',
].join('\n')

export function responsiveToolDecision(name, args = {}) {
  if ((name === 'pwsh' || name === 'bash') && args.run_in_background !== true) {
    return { kind: 'deny', reason: 'Keep this Bot responsive: rerun this same command with run_in_background: true. The command has not started. Keep its job ID and collect with job_output(wait: false); native completion notices resume the work.' }
  }
  if (name === 'job_output' && args.wait === true) {
    return { kind: 'deny', reason: 'Read this existing job with wait: false so the user can receive a response while it continues. Do not stop or restart the job; wait for its native completion notice.' }
  }
  return undefined
}

export function installResponsiveWork(ctx, { host, goals, agents, systemPrompt, managedGoal, waits = new Map() }) {
  const jobs = ctx.get?.('jobs')
  if (!jobs) {
    const fiber = ctx.inject?.(['jobs'], scope => installResponsiveWork(scope, { host, goals, agents, systemPrompt, managedGoal, waits }))
    return () => fiber?.dispose()
  }
  const pending = waits
  const owned = agent => agent && host.owner(agent.id) !== undefined
  const disposers = [
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!owned(exec.agent)) return await next()
      const saved = pending.get(exec.agent.id)
      if (exec.name === 'update_goal' && exec.arguments?.action === 'complete' && saved
        && jobs.list(exec.agent.id).some(job => saved.ids.includes(job.id) && (job.status === 'running' || job.status === 'stopping'))) {
        return { kind: 'deny', reason: 'This task still owns a running background job. Respond to the user, then collect and verify its output after the native completion notice before completing the Goal.' }
      }
      return responsiveToolDecision(exec.name, exec.arguments) ?? await next()
    }),
    ctx.on('tools/result', (exec, result) => {
      if (!owned(exec.agent) || result.isError || !['pwsh', 'bash'].includes(exec.name)) return
      const jobId = result.value?.jobId
      if (!jobId || !jobs.list(exec.agent.id).some(job => job.id === jobId && job.owner === exec.agent.id && job.status === 'running')) return
      const managed = managedGoal(exec.agent)
      if (!managed || managed.goal.phase !== 'active') return
      const previous = pending.get(exec.agent.id)
      const ids = [...new Set([...(previous?.ids ?? []), jobId])]
      pending.set(exec.agent.id, {
        id: managed.goal.id, revision: managed.goal.revision, generation: managed.generation, killed: previous?.killed ?? false, ids,
        cancel: () => { for (const id of ids) jobs.kill(id, exec.agent.id, 'stopped by the user') },
      })
      goals.disarm(exec.agent)
    }),
    jobs.events.subscribe({ owners: 'scope' }, event => {
      if (event.type !== 'settled' || !event.job.owner) return
      const saved = pending.get(event.job.owner)
      if (!saved || !saved.ids.includes(event.job.id)) return
      if (event.cause === 'kill' || event.cause === 'teardown') saved.killed = true
      if (jobs.list(event.job.owner).some(job => saved.ids.includes(job.id) && (job.status === 'running' || job.status === 'stopping'))) return
      pending.delete(event.job.owner)
      if (saved.killed) return
      const agent = agents.get(event.job.owner)
      const managed = agent && managedGoal(agent)
      if (!managed || managed.generation !== saved.generation || managed.goal.id !== saved.id || managed.goal.revision !== saved.revision || managed.goal.phase !== 'active') return
      goals.resume(agent, { id: saved.id, revision: saved.revision })
    }),
    systemPrompt.section({
      name: 'ds-bot-autonomy:responsive-work',
      order: systemPrompt.getSectionOrder('TOOL_GOAL') + 11,
      text: ({ scope } = {}) => host.owner(scope?.id) ? RESPONSIVE_WORK_PROMPT : '',
    }),
  ]
  return () => { pending.clear(); for (const dispose of disposers.reverse()) dispose?.() }
}
