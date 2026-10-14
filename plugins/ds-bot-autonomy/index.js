import { createAutonomyService } from './src/service.js'

export function apply(ctx) {
  let service
  let installDisposer

  ctx.inject(['dsBotAutonomyHost', 'agents', 'goals', 'sessions', 'tools', 'storageDomain', 'systemPrompt'], async services => {
    service = createAutonomyService(services, {
      host: services.dsBotAutonomyHost,
      agents: services.agents,
      goals: services.goals,
      sessions: services.sessions,
      storageDomain: services.storageDomain,
      systemPrompt: services.systemPrompt,
    })
    service.setSchedule(services.get('schedule'))
    await service.initialize()
    installDisposer = service.install(services)
    services.provide('dsBotAutonomy', service.api)
    return async () => {
      await installDisposer?.()
      await service?.dispose()
      service = undefined
      installDisposer = undefined
    }
  })

  ctx.inject(['schedule'], scheduleCtx => {
    service?.setSchedule(scheduleCtx.schedule)
    return () => service?.setSchedule(undefined)
  })
}
