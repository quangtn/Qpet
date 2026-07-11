import type { Activity, PetState } from './contracts'

/** Higher number = higher attention priority (needs input first). */
export const ACTIVITY_PRIORITY: Readonly<Record<PetState, number>> = {
  needs_input: 4,
  blocked: 3,
  running: 2,
  ready: 1
}

export function compareActivities(left: Activity, right: Activity): number {
  const priorityDelta = ACTIVITY_PRIORITY[right.state] - ACTIVITY_PRIORITY[left.state]
  if (priorityDelta !== 0) return priorityDelta

  const timeDelta = right.updatedAt - left.updatedAt
  if (timeDelta !== 0) return timeDelta

  return left.id.localeCompare(right.id)
}

export function sortActivities(activities: readonly Activity[]): Activity[] {
  return [...activities].sort(compareActivities)
}

/** Basename of a project path without depending on Node `path`. */
export function projectNameFor(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  const separator = trimmed.lastIndexOf('/')
  const name = separator >= 0 ? trimmed.slice(separator + 1) : trimmed
  return name || cwd
}
