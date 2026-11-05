import type { ActivityEvent, ActivityStatus } from '@shared/types'

const MAX_EVENTS = 500

export class ActivityLog {
  private events: ActivityEvent[] = []

  constructor(private readonly send: (channel: string, payload: unknown) => void) {}

  list(sessionId?: string): ActivityEvent[] {
    return this.events
      .filter((e) => (sessionId ? e.sessionId === sessionId : true))
      .slice()
      .reverse()
  }

  start(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    agent: { agentSessionId?: string; profileId?: string } = {}
  ): ActivityEvent {
    const event: ActivityEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      agentSessionId: agent.agentSessionId,
      profileId: agent.profileId,
      tool,
      args,
      status: 'pending',
      startedAt: Date.now()
    }
    this.push(event)
    return event
  }

  update(
    id: string,
    status: ActivityStatus,
    patch: { summary?: string; error?: string } = {}
  ): void {
    const event = this.events.find((e) => e.id === id)
    if (!event) return
    event.status = status
    if (patch.summary !== undefined) event.summary = patch.summary
    if (patch.error !== undefined) event.error = patch.error
    if (status !== 'pending' && status !== 'running') event.endedAt = Date.now()
    this.send('activity:event', event)
  }

  private push(event: ActivityEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.send('activity:event', event)
  }
}
