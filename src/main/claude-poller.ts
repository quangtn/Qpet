import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

import type { Activity } from '@shared'
import type { ClaudeAgentObservation } from './provider-normalizers'
import { normalizeClaudeAgents } from './provider-normalizers'

export const CLAUDE_POLL_INTERVAL_MS = 10_000
export const CLAUDE_POLL_TIMEOUT_MS = 5_000
export const CLAUDE_RECONCILE_GRACE_MS = 30_000
const CLAUDE_POLL_MAX_BUFFER_BYTES = 1024 * 1024

export interface ClaudePollActivityStore {
  getActivities?(): Activity[]
  reconcileClaudeAgents(
    observations: readonly ClaudeAgentObservation[],
    missingSessionIds?: ReadonlySet<string> | readonly string[]
  ): Promise<unknown>
}

export interface ClaudeCommandResult {
  stdout: string
  stderr?: string
}

export type ClaudeCommandRunner = (
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<ClaudeCommandResult>

export interface ClaudePollerOptions {
  /** Absolute path discovered during onboarding. */
  binaryPath: string
  activityStore: ClaudePollActivityStore
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  runCommand?: ClaudeCommandRunner
  onError?: (error: Error) => void
}

export interface ClaudePollResult {
  ok: boolean
  observations: ClaudeAgentObservation[]
  missingSessionIds: string[]
  error?: Error
}

/** Polls Claude's research-preview agent view without relying on login-item PATH. */
export class ClaudePoller {
  private readonly binaryPath: string
  private readonly activityStore: ClaudePollActivityStore
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly runCommand: ClaudeCommandRunner
  private readonly onError?: (error: Error) => void
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<ClaudePollResult>
  private observedSessionIds = new Set<string>()

  lastError?: Error

  constructor(options: ClaudePollerOptions) {
    if (!isAbsolute(options.binaryPath)) {
      throw new TypeError('ClaudePoller requires an absolute binary path')
    }
    if (!Number.isInteger(options.intervalMs ?? CLAUDE_POLL_INTERVAL_MS) ||
        (options.intervalMs ?? CLAUDE_POLL_INTERVAL_MS) < 1) {
      throw new RangeError('ClaudePoller intervalMs must be a positive integer')
    }

    this.binaryPath = options.binaryPath
    this.activityStore = options.activityStore
    this.intervalMs = options.intervalMs ?? CLAUDE_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? CLAUDE_POLL_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.runCommand = options.runCommand ?? runClaudeCommand
    this.onError = options.onError
  }

  get isRunning(): boolean {
    return Boolean(this.timer)
  }

  start(): void {
    if (this.timer || process.env.QPET_DISABLE_POLLING === '1') return

    void this.pollNow()
    this.timer = setInterval(() => {
      void this.pollNow()
    }, this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined

    // performPoll includes activity-store reconciliation, so waiting for this
    // promise guarantees no poll-side persistence is still running at teardown.
    const inFlight = this.inFlight
    if (inFlight) await inFlight
  }

  pollNow(): Promise<ClaudePollResult> {
    this.inFlight ??= this.performPoll().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async performPoll(): Promise<ClaudePollResult> {
    try {
      const { stdout } = await this.runCommand(
        this.binaryPath,
        ['agents', '--json'],
        this.timeoutMs
      )
      const pollTime = this.now()
      const observations = parseClaudeAgentOutput(stdout, pollTime)
      const currentIds = new Set(observations.map((observation) => observation.sessionId))
      const missingSessionIds = new Set(
        [...this.observedSessionIds].filter((id) => !currentIds.has(id))
      )
      for (const activity of this.activityStore.getActivities?.() ?? []) {
        if (
          activity.provider === 'claude' &&
          activity.live &&
          !currentIds.has(activity.sessionId) &&
          pollTime - activity.updatedAt >= CLAUDE_RECONCILE_GRACE_MS
        ) {
          missingSessionIds.add(activity.sessionId)
        }
      }

      const missing = [...missingSessionIds]
      await this.activityStore.reconcileClaudeAgents(observations, missing)
      this.observedSessionIds = currentIds
      this.lastError = undefined
      return { ok: true, observations, missingSessionIds: missing }
    } catch (cause) {
      const error = asError(cause)
      this.lastError = error
      try {
        this.onError?.(error)
      } catch {
        // Diagnostic callbacks must not stop the polling loop.
      }
      // Failed polls never close sessions: the previous successful observation
      // set remains intact until Claude returns valid JSON again.
      return { ok: false, observations: [], missingSessionIds: [], error }
    }
  }
}

export function parseClaudeAgentOutput(
  stdout: string | Buffer,
  now = Date.now()
): ClaudeAgentObservation[] {
  const text = (Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout)
    .replace(/^\uFEFF/, '')
    .trim()
  if (!text) throw new Error('claude agents --json returned no data')

  const parsed = JSON.parse(text) as unknown
  if (
    !Array.isArray(parsed) &&
    (!parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as Record<string, unknown>).agents))
  ) {
    throw new Error('claude agents --json did not return an array')
  }

  return normalizeClaudeAgents(parsed, now)
}

export const runClaudeCommand: ClaudeCommandRunner = (
  binaryPath,
  args,
  timeoutMs
) =>
  new Promise<ClaudeCommandResult>((resolve, reject) => {
    execFile(
      binaryPath,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: CLAUDE_POLL_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        windowsHide: true,
        env: process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
