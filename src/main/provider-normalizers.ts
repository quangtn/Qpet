import type { Activity, PetState, Provider } from '../shared/contracts'
import { projectNameFor } from '../shared/activity'

export {
  ACTIVITY_PRIORITY,
  compareActivities,
  sortActivities
} from '../shared/activity'

const MAX_SESSION_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4096
const MAX_JOB_ID_LENGTH = 256

/**
 * Internal representation of a hook event after the privacy boundary.  No raw
 * hook payload is retained beyond the call that creates this value.
 */
export interface NormalizedProviderEvent extends Activity {
  /** A closed session remains in history, but must never be treated as live. */
  close?: boolean
  /** Used only in memory to collapse two provider events for the same prompt. */
  dedupeKey?: string
  /** Transient adapter evidence used to resolve cross-provider collisions. */
  matchConfidence?: number
}

export interface ProviderCapabilities {
  inputRequests: boolean
  explicitCompletion: boolean
  authoritativePresence: boolean
  reconciliation: 'hook-stale' | 'agents-json' | 'inactivity'
  settleAfterMs?: number
}

export interface ProviderAdapter {
  provider: Provider
  capabilities: ProviderCapabilities
  match(payload: unknown): number
  normalize(payload: unknown, now?: number): NormalizedProviderEvent | null
}

/** A privacy-safe snapshot returned by `claude agents --json`. */
export interface ClaudeAgentObservation {
  provider: 'claude'
  sessionId: string
  cwd: string
  projectName: string
  state?: PetState
  summary?: string
  live: boolean
  backgroundJobId?: string
  observedAt: number
}

export function activityId(provider: Provider, sessionId: string): string {
  return `${provider}:${sessionId}`
}

export function normalizeProviderEvent(
  provider: Provider,
  payload: unknown,
  now = Date.now()
): NormalizedProviderEvent | null {
  const adapter = providerAdapters[provider]
  const matchConfidence = adapter.match(payload)
  if (matchConfidence === 0) return null
  const event = adapter.normalize(payload, now)
  return event ? { ...event, matchConfidence } : null
}

export function normalizeCursorEvent(
  payload: unknown,
  now = Date.now()
): NormalizedProviderEvent | null {
  const input = asRecord(payload)
  if (!input || cursorPayloadMatch(input) === 0) return null

  const identity = readIdentity('cursor', input)
  if (!identity) return null

  const eventName = canonicalEventName(readString(input, [
    'hook_event_name',
    'hookEventName',
    'event_name',
    'eventName',
    'event',
    'type'
  ]))

  switch (eventName) {
    case 'sessionstart':
      return null
    case 'beforesubmitprompt':
    case 'afteragentthought':
    case 'posttooluse':
      return makeEvent(identity, 'running', 'Cursor is working', now, false)
    case 'afteragentresponse':
      // Cursor can omit Stop for some completed turns. A completed agent
      // response is itself sufficient evidence that the turn is ready.
      return makeEvent(identity, 'ready', 'Cursor finished', now, true, undefined, false)
    case 'stop':
      return makeEvent(identity, 'ready', 'Cursor finished', now, true, undefined, false)
    case 'sessionend': {
      const event = makeEvent(identity, 'ready', 'Cursor session ended', now, false, undefined, false)
      event.close = true
      return event
    }
    default:
      // Cursor does not currently expose a reliable approval-request lifecycle
      // hook. Tool failures remain recoverable and are not session blockers.
      return null
  }
}

export function normalizeCodexEvent(
  payload: unknown,
  now = Date.now()
): NormalizedProviderEvent | null {
  const input = asRecord(payload)
  if (!input || codexPayloadMatch(input) === 0) return null

  const identity = readIdentity('codex', input)
  if (!identity) return null

  const eventName = canonicalEventName(readString(input, [
    'hook_event_name',
    'hookEventName',
    'event_name',
    'eventName',
    'event',
    'type'
  ]))

  switch (eventName) {
    case 'sessionstart':
      // SessionStart can fire for a resumed but idle thread. Wait for a prompt
      // before claiming that Codex is actively working.
      return null
    case 'userpromptsubmit':
      return makeEvent(identity, 'running', 'Codex is working', now, false)
    case 'permissionrequest':
      return makeEvent(
        identity,
        'needs_input',
        'Codex needs approval',
        now,
        true,
        'permission'
      )
    case 'posttooluse':
      // A completed tool means any preceding approval was resolved and the
      // turn is active again. Non-zero tool results are recoverable, not blockers.
      return makeEvent(identity, 'running', 'Codex is working', now, false)
    case 'stop':
    case 'agentturncomplete':
      return makeEvent(identity, 'ready', 'Codex finished', now, true, undefined, false)
    default:
      // In particular, PostToolUse failures are not session failures.
      return null
  }
}

export function normalizeClaudeEvent(
  payload: unknown,
  now = Date.now()
): NormalizedProviderEvent | null {
  const input = asRecord(payload)
  if (!input || claudePayloadMatch(input) === 0) return null

  const identity = readIdentity('claude', input)
  if (!identity) return null

  const eventName = canonicalEventName(readString(input, [
    'hook_event_name',
    'hookEventName',
    'event_name',
    'eventName',
    'event',
    'type'
  ]))

  switch (eventName) {
    case 'sessionstart':
      // Registration alone is not work. Polling can still discover an already
      // active Claude session, while UserPromptSubmit is the immediate signal.
      return null
    case 'userpromptsubmit':
      return makeEvent(identity, 'running', 'Claude is working', now, false)
    case 'permissionrequest':
      return makeEvent(
        identity,
        'needs_input',
        'Claude needs approval',
        now,
        true,
        'permission'
      )
    case 'elicitation':
      return makeEvent(
        identity,
        'needs_input',
        'Claude needs input',
        now,
        true,
        'input'
      )
    case 'pretooluse': {
      const toolName = canonicalEventName(readString(input, ['tool_name', 'toolName']))
      if (toolName !== 'askuserquestion') return null
      return makeEvent(
        identity,
        'needs_input',
        'Claude needs an answer',
        now,
        true,
        'input'
      )
    }
    case 'posttooluse':
      return makeEvent(identity, 'running', 'Claude is working', now, false)
    case 'notification': {
      const notificationType = canonicalEventName(readString(input, [
        'notification_type',
        'notificationType'
      ]))

      if (notificationType === 'permissionprompt') {
        return makeEvent(
          identity,
          'needs_input',
          'Claude needs approval',
          now,
          true,
          'permission'
        )
      }

      if (
        notificationType === 'idleprompt' ||
        notificationType === 'elicitationdialog' ||
        notificationType === 'requiredinput'
      ) {
        return makeEvent(
          identity,
          'needs_input',
          'Claude needs input',
          now,
          true,
          'input'
        )
      }

      return null
    }
    case 'stop':
      if (hasOutstandingWork(input.background_tasks) || hasOutstandingWork(input.session_crons)) {
        return makeEvent(identity, 'running', 'Claude is still working', now, false)
      }
      return makeEvent(identity, 'ready', 'Claude finished', now, true)
    case 'stopfailure':
      return makeEvent(identity, 'blocked', 'Claude could not finish', now, true)
    case 'sessionend': {
      const event = makeEvent(identity, 'ready', 'Claude session ended', now, false)
      event.close = true
      event.live = false
      return event
    }
    default:
      // Tool failures are intentionally ignored. A StopFailure is the only
      // Claude hook failure that represents a failed turn.
      return null
  }
}

export function normalizeClaudeAgent(
  payload: unknown,
  now = Date.now()
): ClaudeAgentObservation | null {
  const input = asRecord(payload)
  if (!input) return null

  const sessionId = cleanString(
    readString(input, ['sessionId', 'session_id', 'id']),
    MAX_SESSION_ID_LENGTH
  )
  const cwd = cleanString(readString(input, ['cwd']), MAX_PATH_LENGTH)
  if (!sessionId || !cwd) return null

  const kind = canonicalEventName(readString(input, ['kind']))
  const jobId = cleanString(readString(input, ['id', 'jobId', 'job_id']), MAX_JOB_ID_LENGTH)
  const stateName = canonicalEventName(readString(input, ['state']))

  let state: PetState | undefined
  let summary: string | undefined
  let live = true

  switch (stateName) {
    case 'working':
    case 'running':
      state = 'running'
      summary = 'Claude is working'
      break
    case 'blocked':
    case 'waiting':
    case 'needsinput':
      state = 'needs_input'
      summary = 'Claude needs input'
      break
    case 'done':
    case 'completed':
      state = 'ready'
      summary = 'Claude finished'
      live = false
      break
    case 'failed':
      state = 'blocked'
      summary = 'Claude could not finish'
      live = false
      break
    case 'stopped':
      state = 'ready'
      summary = 'Claude session stopped'
      live = false
      break
    default:
      // Interactive entries currently have no state. Their presence proves
      // liveness, but must not overwrite a more precise state from hooks.
      break
  }

  return {
    provider: 'claude',
    sessionId,
    cwd,
    projectName: projectNameFor(cwd),
    state,
    summary,
    live,
    backgroundJobId: kind === 'background' && jobId ? jobId : undefined,
    observedAt: now
  }
}

export function normalizeClaudeAgents(
  payload: unknown,
  now = Date.now()
): ClaudeAgentObservation[] {
  const records = Array.isArray(payload)
    ? payload
    : asRecord(payload) && Array.isArray(asRecord(payload)?.agents)
      ? (asRecord(payload)?.agents as unknown[])
      : []

  const bySession = new Map<string, ClaudeAgentObservation>()
  for (const record of records) {
    const observation = normalizeClaudeAgent(record, now)
    if (observation) bySession.set(observation.sessionId, observation)
  }
  return [...bySession.values()]
}

function makeEvent(
  identity: Pick<Activity, 'id' | 'provider' | 'sessionId' | 'cwd' | 'projectName'>,
  state: PetState,
  summary: string,
  updatedAt: number,
  unread: boolean,
  dedupeKind?: string,
  live = true
): NormalizedProviderEvent {
  return {
    ...identity,
    state,
    summary,
    updatedAt,
    unread,
    live,
    dedupeKey: dedupeKind ? `${identity.provider}:${identity.sessionId}:${dedupeKind}` : undefined
  }
}

function readIdentity(
  provider: Provider,
  input: Record<string, unknown>
): Pick<Activity, 'id' | 'provider' | 'sessionId' | 'cwd' | 'projectName'> | null {
  const sessionKeys = provider === 'cursor'
    ? ['conversation_id', 'conversationId']
    : provider === 'codex'
      ? ['session_id', 'sessionId', 'thread_id', 'threadId', 'thread-id', 'session-id']
      : ['session_id', 'sessionId', 'session-id']
  const sessionId = cleanString(
    readString(input, sessionKeys),
    MAX_SESSION_ID_LENGTH
  )
  const cwd = cleanString(readWorkingDirectory(input), MAX_PATH_LENGTH)

  if (!sessionId || !cwd) return null

  return {
    id: activityId(provider, sessionId),
    provider,
    sessionId,
    cwd,
    projectName: projectNameFor(cwd)
  }
}

function readWorkingDirectory(input: Record<string, unknown>): string | undefined {
  const direct = readString(input, [
    'cwd',
    'working_directory',
    'workingDirectory',
    'workspace_root',
    'workspaceRoot'
  ])
  if (direct) return direct

  for (const key of ['workspace_roots', 'workspaceRoots']) {
    const roots = input[key]
    if (Array.isArray(roots)) {
      const first = roots.find((root): root is string => typeof root === 'string' && root.trim() !== '')
      if (first) return first
    }
  }
  return undefined
}

function canonicalEventName(value: string | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
}

function cleanString(value: string | undefined, maximumLength: number): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/\0/g, '').trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, maximumLength)
}

function readString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasOutstandingWork(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

const CODEX_EVENTS = new Set([
  'sessionstart',
  'userpromptsubmit',
  'permissionrequest',
  'posttooluse',
  'stop',
  'agentturncomplete'
])
const CLAUDE_EVENTS = new Set([
  'sessionstart',
  'userpromptsubmit',
  'permissionrequest',
  'elicitation',
  'pretooluse',
  'posttooluse',
  'notification',
  'stop',
  'stopfailure',
  'sessionend'
])
const CURSOR_EVENTS = new Set([
  'sessionstart',
  'beforesubmitprompt',
  'afteragentthought',
  'posttooluse',
  'afteragentresponse',
  'stop',
  'sessionend'
])

function eventName(input: Record<string, unknown>): string {
  return canonicalEventName(readString(input, [
    'hook_event_name',
    'hookEventName',
    'event_name',
    'eventName',
    'event',
    'type'
  ]))
}

function hasCursorFingerprint(input: Record<string, unknown>): boolean {
  return hasAnyKey(input, ['conversation_id', 'conversationId', 'workspace_roots', 'workspaceRoots'])
}

function hasAnyKey(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(input, key))
}

function cursorPayloadMatch(input: Record<string, unknown>): number {
  if (!hasAnyKey(input, ['conversation_id', 'conversationId'])) return 0
  return CURSOR_EVENTS.has(eventName(input)) ? 3 : 0
}

function claudePayloadMatch(input: Record<string, unknown>): number {
  if (hasCursorFingerprint(input) || !CLAUDE_EVENTS.has(eventName(input))) return 0
  if (!readString(input, ['session_id', 'sessionId', 'session-id']) || !readWorkingDirectory(input)) {
    return 0
  }
  return hasAnyKey(input, [
    'notification_type',
    'notificationType',
    'background_tasks',
    'session_crons',
    'transcript_path'
  ]) ? 3 : 2
}

function codexPayloadMatch(input: Record<string, unknown>): number {
  if (hasCursorFingerprint(input) || !CODEX_EVENTS.has(eventName(input))) return 0
  if (!readString(input, [
    'session_id',
    'sessionId',
    'thread_id',
    'threadId',
    'thread-id',
    'session-id'
  ]) || !readWorkingDirectory(input)) {
    return 0
  }
  return hasAnyKey(input, ['thread_id', 'threadId', 'thread-id']) || eventName(input) === 'agentturncomplete'
    ? 3
    : 2
}

export const providerAdapters: Readonly<Record<Provider, ProviderAdapter>> = {
  codex: {
    provider: 'codex',
    capabilities: {
      inputRequests: true,
      explicitCompletion: true,
      authoritativePresence: false,
      reconciliation: 'hook-stale',
      settleAfterMs: 24 * 60 * 60 * 1_000
    },
    match: (payload) => {
      const input = asRecord(payload)
      return input ? codexPayloadMatch(input) : 0
    },
    normalize: normalizeCodexEvent
  },
  claude: {
    provider: 'claude',
    capabilities: {
      inputRequests: true,
      explicitCompletion: true,
      authoritativePresence: true,
      reconciliation: 'agents-json',
      settleAfterMs: 5 * 60 * 1_000
    },
    match: (payload) => {
      const input = asRecord(payload)
      return input ? claudePayloadMatch(input) : 0
    },
    normalize: normalizeClaudeEvent
  },
  cursor: {
    provider: 'cursor',
    capabilities: {
      inputRequests: false,
      explicitCompletion: true,
      authoritativePresence: false,
      reconciliation: 'inactivity',
      settleAfterMs: 5 * 60 * 1_000
    },
    match: (payload) => {
      const input = asRecord(payload)
      return input ? cursorPayloadMatch(input) : 0
    },
    normalize: normalizeCursorEvent
  }
}
