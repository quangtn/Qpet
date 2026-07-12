import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Activity, PetState, Provider } from '../shared/contracts'
import { projectNameFor } from '../shared/activity'
import {
  activityId,
  normalizeProviderEvent,
  providerAdapters,
  sortActivities,
  type ClaudeAgentObservation,
  type NormalizedProviderEvent
} from './provider-normalizers'

export const CODEX_STALE_AFTER_MS = providerAdapters.codex.capabilities.settleAfterMs ?? 0
export const CURSOR_STALE_AFTER_MS = providerAdapters.cursor.capabilities.settleAfterMs ?? 0
export const CLAUDE_IDLE_AFTER_MS = providerAdapters.claude.capabilities.settleAfterMs ?? 0
export const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const PERMISSION_DEDUPE_WINDOW_MS = 5_000
export const PROVIDER_COLLISION_WINDOW_MS = 2_000
export const ACTIVITY_FILE_NAME = 'activities.json'

export interface ActivityStoreDiagnostic {
  type: 'provider_collision'
  acceptedProvider: Provider
  rejectedProvider: Provider
}

interface StoredActivities {
  version: 1
  activities: Activity[]
}

export interface ActivityStoreOptions {
  /** Full file path. Defaults to `<supportDir>/activities.json`. */
  filePath?: string
  /** Electron's user-data/app-support path can be supplied by the caller. */
  supportDir?: string
  now?: () => number
  codexStaleAfterMs?: number
  cursorStaleAfterMs?: number
  claudeIdleAfterMs?: number
  retentionMs?: number
  dedupeWindowMs?: number
  collisionWindowMs?: number
  onDiagnostic?(diagnostic: ActivityStoreDiagnostic): void
}

export interface ActivityMutation {
  changed: boolean
  duplicate: boolean
  activity?: Activity
  previous?: Activity
}

export interface ActivityStoreChange {
  activities: Activity[]
  activity?: Activity
  previous?: Activity
  removedId?: string
}

export type ActivityStoreListener = (change: ActivityStoreChange) => void

/**
 * Owns the complete persistence boundary for provider activity. Only Activity
 * fields are ever serialized; the provider's raw prompt, command, tool output,
 * transcript path, and response are discarded by the normalizer.
 */
export class ActivityStore {
  readonly filePath: string

  private readonly now: () => number
  private readonly codexStaleAfterMs: number
  private readonly cursorStaleAfterMs: number
  private readonly claudeIdleAfterMs: number
  private readonly retentionMs: number
  private readonly dedupeWindowMs: number
  private readonly collisionWindowMs: number
  private readonly onDiagnostic?: (diagnostic: ActivityStoreDiagnostic) => void
  private activities = new Map<string, Activity>()
  private readonly listeners = new Set<ActivityStoreListener>()
  private readonly recentDedupeKeys = new Map<string, number>()
  private readonly recentProviderConfidence = new Map<string, number>()
  private loadPromise?: Promise<void>
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(options: ActivityStoreOptions | string = {}) {
    const normalizedOptions = typeof options === 'string' ? { filePath: options } : options
    const supportDir =
      normalizedOptions.supportDir ??
      process.env.QPET_SUPPORT_DIR ??
      join(homedir(), 'Library', 'Application Support', 'QPet')

    this.filePath = normalizedOptions.filePath ?? join(supportDir, ACTIVITY_FILE_NAME)
    this.now = normalizedOptions.now ?? Date.now
    this.codexStaleAfterMs = normalizedOptions.codexStaleAfterMs ?? CODEX_STALE_AFTER_MS
    this.cursorStaleAfterMs = normalizedOptions.cursorStaleAfterMs ?? CURSOR_STALE_AFTER_MS
    this.claudeIdleAfterMs = normalizedOptions.claudeIdleAfterMs ?? CLAUDE_IDLE_AFTER_MS
    this.retentionMs = normalizedOptions.retentionMs ?? ACTIVITY_RETENTION_MS
    this.dedupeWindowMs = normalizedOptions.dedupeWindowMs ?? PERMISSION_DEDUPE_WINDOW_MS
    this.collisionWindowMs = normalizedOptions.collisionWindowMs ?? PROVIDER_COLLISION_WINDOW_MS
    this.onDiagnostic = normalizedOptions.onDiagnostic
  }

  async initialize(): Promise<void> {
    await this.load()
  }

  async load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk()
    await this.loadPromise
  }

  getActivities(): Activity[] {
    return sortActivities([...this.activities.values()].map(cloneActivity))
  }

  list(): Activity[] {
    return this.getActivities()
  }

  getActivity(id: string): Activity | undefined {
    const activity = this.activities.get(id)
    return activity ? cloneActivity(activity) : undefined
  }

  subscribe(listener: ActivityStoreListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onChange(listener: ActivityStoreListener): () => void {
    return this.subscribe(listener)
  }

  async ingest(provider: Provider, payload: unknown): Promise<ActivityMutation | null> {
    const event = normalizeProviderEvent(provider, payload, this.now())
    if (!event) return null
    return this.applyEvent(event)
  }

  async applyEvent(event: NormalizedProviderEvent): Promise<ActivityMutation> {
    return this.enqueue(async () => {
      const previous = this.activities.get(event.id)
      const eventTime = finiteTimestamp(event.updatedAt, this.now())
      const collision = this.findProviderCollision(event, eventTime)

      if (collision) {
        const incomingConfidence = event.matchConfidence ?? 1
        const existingConfidence = this.recentProviderConfidence.get(collision.id) ?? 1
        if (incomingConfidence <= existingConfidence) {
          this.reportCollision(collision.provider, event.provider)
          return {
            changed: false,
            duplicate: true,
            activity: cloneActivity(collision),
            previous: cloneActivity(collision)
          }
        }
      }

      if (event.dedupeKey && this.isDuplicate(event, previous, eventTime)) {
        return {
          changed: false,
          duplicate: true,
          activity: previous ? cloneActivity(previous) : undefined,
          previous: previous ? cloneActivity(previous) : undefined
        }
      }

      const next = event.close
        ? closeActivity(event, previous, eventTime)
        : mergeActivity(event, previous, eventTime)

      if (event.dedupeKey) this.recentDedupeKeys.set(event.dedupeKey, eventTime)
      this.pruneDedupeKeys(eventTime)

      if (previous && equalActivity(previous, next)) {
        return {
          changed: false,
          duplicate: false,
          activity: cloneActivity(previous),
          previous: cloneActivity(previous)
        }
      }

      const nextActivities = new Map(this.activities)
      if (collision) {
        nextActivities.delete(collision.id)
        this.recentProviderConfidence.delete(collision.id)
        this.reportCollision(event.provider, collision.provider)
      }
      nextActivities.set(next.id, next)
      this.recentProviderConfidence.set(next.id, event.matchConfidence ?? 1)
      await this.commit(nextActivities)
      this.emit({
        activities: this.getActivities(),
        activity: cloneActivity(next),
        previous: previous ? cloneActivity(previous) : undefined
      })

      return {
        changed: true,
        duplicate: false,
        activity: cloneActivity(next),
        previous: previous ? cloneActivity(previous) : undefined
      }
    })
  }

  /**
   * Reconcile a successful `claude agents --json` poll. The caller supplies
   * only session ids that disappeared from a previous successful poll, so a
   * first poll cannot accidentally close a newly-hooked foreground session.
   */
  async reconcileClaudeAgents(
    observations: readonly ClaudeAgentObservation[],
    missingSessionIds: ReadonlySet<string> | readonly string[] = []
  ): Promise<ActivityMutation[]> {
    return this.enqueue(async () => {
      const nextActivities = new Map(this.activities)
      const mutations: ActivityMutation[] = []

      for (const observation of observations) {
        const id = activityId('claude', observation.sessionId)
        const previous = nextActivities.get(id)
        const next = activityFromObservation(observation, previous, this.claudeIdleAfterMs)
        if (!next) continue
        if (previous && equalActivity(previous, next)) continue

        nextActivities.set(id, next)
        mutations.push({
          changed: true,
          duplicate: false,
          activity: cloneActivity(next),
          previous: previous ? cloneActivity(previous) : undefined
        })
      }

      for (const sessionId of missingSessionIds) {
        const id = activityId('claude', sessionId)
        const previous = nextActivities.get(id)
        if (!previous?.live) continue

        const next = closeMissingClaudeActivity(previous, this.now())
        nextActivities.set(id, next)
        mutations.push({
          changed: true,
          duplicate: false,
          activity: cloneActivity(next),
          previous: cloneActivity(previous)
        })
      }

      if (mutations.length === 0) return mutations

      await this.commit(nextActivities)
      const last = mutations[mutations.length - 1]
      this.emit({
        activities: this.getActivities(),
        activity: last.activity,
        previous: last.previous
      })
      return mutations
    })
  }

  async markRead(activityIdToMark?: string): Promise<void> {
    await this.enqueue(async () => {
      const nextActivities = new Map(this.activities)
      let changed = false

      for (const [id, activity] of nextActivities) {
        const shouldMark = activityIdToMark ? id === activityIdToMark : activity.state === 'ready'
        if (!shouldMark || !activity.unread) continue
        nextActivities.set(id, { ...activity, unread: false })
        changed = true
      }

      if (!changed) return
      await this.commit(nextActivities)
      this.emit({ activities: this.getActivities() })
    })
  }

  async dismiss(id: string): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.activities.get(id)
      if (!previous) return

      const nextActivities = new Map(this.activities)
      nextActivities.delete(id)
      await this.commit(nextActivities)
      this.emit({
        activities: this.getActivities(),
        previous: cloneActivity(previous),
        removedId: id
      })
    })
  }

  async cleanup(now = this.now()): Promise<number> {
    return this.enqueue(async () => {
      const nextActivities = new Map(this.activities)
      let changed = 0

      for (const [id, activity] of nextActivities) {
        const settled = settleInactiveCursor(activity, now, this.cursorStaleAfterMs)
        if (settled !== activity) {
          nextActivities.set(id, settled)
          changed += 1
          continue
        }
        if (shouldExpire(
          activity,
          now,
          this.codexStaleAfterMs,
          this.retentionMs
        )) {
          nextActivities.delete(id)
          changed += 1
        }
      }

      if (changed === 0) return 0
      await this.commit(nextActivities)
      this.emit({ activities: this.getActivities() })
      return changed
    })
  }

  async flush(): Promise<void> {
    await this.load()
    await this.operationQueue
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // A corrupt activity cache is non-critical. Leave it untouched so it can
      // be inspected, then start with an empty in-memory view.
      if (error instanceof SyntaxError) return
      throw error
    }

    const records = readStoredRecords(parsed)
    const loaded = new Map<string, Activity>()
    for (const record of records) {
      const activity = validateStoredActivity(record)
      if (activity) loaded.set(activity.id, activity)
    }

    const now = this.now()
    for (const [id, activity] of loaded) {
      const settled = settleInactiveCursor(activity, now, this.cursorStaleAfterMs)
      if (settled !== activity) loaded.set(id, settled)
      if (shouldExpire(
        settled,
        now,
        this.codexStaleAfterMs,
        this.retentionMs
      )) loaded.delete(id)
    }
    this.activities = loaded
  }

  private isDuplicate(
    event: NormalizedProviderEvent,
    previous: Activity | undefined,
    eventTime: number
  ): boolean {
    const recentTime = event.dedupeKey
      ? this.recentDedupeKeys.get(event.dedupeKey)
      : undefined
    if (recentTime !== undefined && eventTime - recentTime <= this.dedupeWindowMs) return true

    return Boolean(
      previous &&
        previous.state === event.state &&
        previous.summary === event.summary &&
        eventTime >= previous.updatedAt &&
        eventTime - previous.updatedAt <= this.dedupeWindowMs
    )
  }

  private pruneDedupeKeys(now: number): void {
    for (const [key, timestamp] of this.recentDedupeKeys) {
      if (now - timestamp > this.dedupeWindowMs) this.recentDedupeKeys.delete(key)
    }
  }

  private findProviderCollision(
    event: NormalizedProviderEvent,
    eventTime: number
  ): Activity | undefined {
    for (const activity of this.activities.values()) {
      if (
        activity.provider !== event.provider &&
        activity.sessionId === event.sessionId &&
        activity.cwd === event.cwd &&
        activity.state === event.state &&
        Math.abs(eventTime - activity.updatedAt) <= this.collisionWindowMs
      ) {
        return activity
      }
    }
    return undefined
  }

  private reportCollision(acceptedProvider: Provider, rejectedProvider: Provider): void {
    try {
      this.onDiagnostic?.({
        type: 'provider_collision',
        acceptedProvider,
        rejectedProvider
      })
    } catch {
      // Diagnostics must never interrupt provider event processing.
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    await this.load()
    const run = this.operationQueue.then(operation, operation)
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async commit(nextActivities: Map<string, Activity>): Promise<void> {
    await writeActivitiesAtomically(this.filePath, nextActivities.values())
    this.activities = nextActivities
  }

  private emit(change: ActivityStoreChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A UI subscriber must not break provider ingestion or persistence.
      }
    }
  }
}

export function shouldExpire(
  activity: Activity,
  now: number,
  codexStaleAfterMs = CODEX_STALE_AFTER_MS,
  retentionMs = ACTIVITY_RETENTION_MS
): boolean {
  const age = Math.max(0, now - activity.updatedAt)
  if (
    activity.provider === 'codex' &&
    (activity.state === 'running' || activity.state === 'needs_input')
  ) {
    return age >= codexStaleAfterMs
  }

  if (activity.state === 'ready' || activity.state === 'blocked') {
    return age >= retentionMs
  }

  return false
}

function settleInactiveCursor(
  activity: Activity,
  now: number,
  inactiveAfterMs: number
): Activity {
  if (
    activity.provider !== 'cursor' ||
    activity.state !== 'running' ||
    Math.max(0, now - activity.updatedAt) < inactiveAfterMs
  ) {
    return activity
  }
  return toPersistedActivity({
    ...activity,
    state: 'ready',
    summary: 'Cursor session inactive',
    updatedAt: now,
    unread: true,
    live: false
  })
}

export async function writeActivitiesAtomically(
  filePath: string,
  activities: Iterable<Activity>
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const body: StoredActivities = {
    version: 1,
    activities: sortActivities([...activities]).map(toPersistedActivity)
  }

  try {
    await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function mergeActivity(
  event: NormalizedProviderEvent,
  previous: Activity | undefined,
  updatedAt: number
): Activity {
  return toPersistedActivity({
    id: activityId(event.provider, event.sessionId),
    provider: event.provider,
    sessionId: event.sessionId,
    cwd: event.cwd,
    projectName: projectNameFor(event.cwd),
    state: event.state,
    summary: event.summary,
    updatedAt,
    unread: event.unread,
    live: event.live,
    backgroundJobId: event.backgroundJobId ?? previous?.backgroundJobId
  })
}

function closeActivity(
  event: NormalizedProviderEvent,
  previous: Activity | undefined,
  updatedAt: number
): Activity {
  const preservedState =
    previous?.state === 'ready' || previous?.state === 'blocked' ? previous.state : 'ready'
  const preservedSummary =
    previous && (previous.state === 'ready' || previous.state === 'blocked')
      ? previous.summary
      : event.summary

  return toPersistedActivity({
    id: activityId(event.provider, event.sessionId),
    provider: event.provider,
    sessionId: event.sessionId,
    cwd: event.cwd,
    projectName: projectNameFor(event.cwd),
    state: preservedState,
    summary: preservedSummary,
    updatedAt,
    unread: previous?.unread ?? false,
    live: false,
    backgroundJobId: event.backgroundJobId ?? previous?.backgroundJobId
  })
}

function activityFromObservation(
  observation: ClaudeAgentObservation,
  previous: Activity | undefined,
  idleAfterMs: number
): Activity | undefined {
  // A foreground entry in `claude agents --json` proves only that the process
  // is alive. Hooks remain the source of truth for whether it is actively
  // working, waiting, or finished.
  if (!previous && observation.state === undefined) return undefined

  const quietLiveSession =
    previous?.state === 'running' &&
    observation.state === undefined &&
    observation.observedAt - previous.updatedAt >= idleAfterMs
  const state = quietLiveSession ? 'ready' : (observation.state ?? previous?.state ?? 'running')
  const summary = quietLiveSession
    ? 'Claude session idle'
    : (observation.summary ?? previous?.summary ?? 'Claude session active')
  const stateChanged = previous ? state !== previous.state || summary !== previous.summary : true

  return toPersistedActivity({
    id: activityId('claude', observation.sessionId),
    provider: 'claude',
    sessionId: observation.sessionId,
    cwd: observation.cwd,
    projectName: projectNameFor(observation.cwd),
    state,
    summary,
    updatedAt: stateChanged ? observation.observedAt : (previous?.updatedAt ?? observation.observedAt),
    unread: quietLiveSession
      ? false
      : observation.state && stateChanged
        ? observation.state !== 'running'
        : (previous?.unread ?? false),
    live: observation.live,
    backgroundJobId: observation.backgroundJobId ?? previous?.backgroundJobId
  })
}

function closeMissingClaudeActivity(previous: Activity, now: number): Activity {
  const preserveFailure = previous.state === 'blocked'
  const preserveCompletion = previous.state === 'ready'
  return toPersistedActivity({
    ...previous,
    state: preserveFailure ? 'blocked' : 'ready',
    summary:
      preserveFailure || preserveCompletion ? previous.summary : 'Claude session ended',
    updatedAt: now,
    live: false,
    unread: preserveCompletion || preserveFailure ? previous.unread : true
  })
}

function readStoredRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const activities = (value as Record<string, unknown>).activities
  return Array.isArray(activities) ? activities : []
}

function validateStoredActivity(value: unknown): Activity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const provider = input.provider
  const state = input.state
  const sessionId = cleanStoredString(input.sessionId, 256)
  const cwd = cleanStoredString(input.cwd, 4096)
  const summary = cleanStoredString(input.summary, 160)
  const updatedAt = input.updatedAt

  if (
    (provider !== 'codex' && provider !== 'claude' && provider !== 'cursor') ||
    !isPetState(state) ||
    !sessionId ||
    !cwd ||
    !summary ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    typeof input.unread !== 'boolean' ||
    typeof input.live !== 'boolean'
  ) {
    return null
  }

  const backgroundJobId = cleanStoredString(input.backgroundJobId, 256)
  return toPersistedActivity({
    id: activityId(provider, sessionId),
    provider,
    sessionId,
    cwd,
    projectName: projectNameFor(cwd),
    state,
    summary,
    updatedAt,
    unread: input.unread,
    live: input.live,
    backgroundJobId
  })
}

function toPersistedActivity(activity: Activity): Activity {
  const result: Activity = {
    id: activity.id,
    provider: activity.provider,
    sessionId: activity.sessionId,
    cwd: activity.cwd,
    projectName: activity.projectName,
    state: activity.state,
    summary: activity.summary,
    updatedAt: activity.updatedAt,
    unread: activity.unread,
    live: activity.live
  }
  if (activity.backgroundJobId) result.backgroundJobId = activity.backgroundJobId
  return result
}

function cleanStoredString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/\0/g, '').trim()
  return cleaned ? cleaned.slice(0, maximumLength) : undefined
}

function isPetState(value: unknown): value is PetState {
  return value === 'running' || value === 'needs_input' || value === 'ready' || value === 'blocked'
}

function finiteTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function equalActivity(left: Activity, right: Activity): boolean {
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.sessionId === right.sessionId &&
    left.cwd === right.cwd &&
    left.projectName === right.projectName &&
    left.state === right.state &&
    left.summary === right.summary &&
    left.updatedAt === right.updatedAt &&
    left.unread === right.unread &&
    left.live === right.live &&
    left.backgroundJobId === right.backgroundJobId
  )
}

function cloneActivity(activity: Activity): Activity {
  return { ...activity }
}
