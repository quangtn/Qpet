import type { Activity, IntegrationHealth, PetState } from '@shared'
import { sortActivities } from '@shared'

export type PetMood = PetState | 'sleeping'

export { sortActivities }

export const stateLabels: Record<PetMood, string> = {
  sleeping: 'Sleeping',
  running: 'Working',
  needs_input: 'Needs input',
  ready: 'Ready',
  blocked: 'Blocked'
}

export const stateDescriptions: Record<PetMood, string> = {
  sleeping: 'No active sessions',
  running: 'An agent is working',
  needs_input: 'An agent needs your attention',
  ready: 'Work is ready to review',
  blocked: 'An agent could not continue'
}

export const healthLabels: Record<IntegrationHealth, string> = {
  not_installed: 'Not installed',
  awaiting_trust: 'Awaiting trust',
  healthy: 'Connected',
  unavailable: 'Unavailable',
  error: 'Needs attention'
}

export function getPetMood(activities: Activity[]): PetMood {
  const relevant = activities.filter(
    (activity) => {
      if (activity.state === 'ready') return activity.unread
      return activity.live
    }
  )
  return sortActivities(relevant)[0]?.state ?? 'sleeping'
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function sessionActions(activity: Activity): Array<
  'open_project' | 'attach' | 'resume' | 'copy_command'
> {
  if (!activity.live) {
    return activity.provider === 'cursor'
      ? ['open_project', 'copy_command']
      : ['resume', 'open_project', 'copy_command']
  }
  if (activity.provider === 'claude' && activity.backgroundJobId) {
    return ['attach', 'open_project', 'copy_command']
  }
  return ['open_project', 'copy_command']
}
