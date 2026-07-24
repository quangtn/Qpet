import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_RECONCILE_GRACE_MS,
  ClaudePoller,
  parseClaudeAgentOutput,
  type ClaudeCommandRunner
} from '../src/main/claude-poller'

describe('ClaudePoller', () => {
  it('parses current interactive and background agent-view records', () => {
    const observations = parseClaudeAgentOutput(
      JSON.stringify([
        {
          pid: 123,
          cwd: '/tmp/interactive',
          kind: 'interactive',
          startedAt: 10,
          sessionId: 'interactive-session',
          name: 'private name'
        },
        {
          id: 'job-1',
          sessionId: 'background-session',
          cwd: '/tmp/background',
          kind: 'background',
          state: 'failed',
          summary: 'private failure'
        }
      ]),
      99
    )

    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({
      sessionId: 'interactive-session',
      live: true,
      observedAt: 99
    })
    expect(observations[0].state).toBeUndefined()
    expect(observations[1]).toMatchObject({
      sessionId: 'background-session',
      backgroundJobId: 'job-1',
      state: 'blocked',
      summary: 'Claude could not finish',
      live: false
    })
    expect(JSON.stringify(observations)).not.toContain('private')
  })

  it('only closes missing sessions after successful polls', async () => {
    const outputs = [
      JSON.stringify([
        {
          sessionId: 'session-1',
          cwd: '/tmp/project',
          kind: 'interactive'
        }
      ]),
      'not-json',
      '[]'
    ]
    const runCommand: ClaudeCommandRunner = vi.fn(async () => ({ stdout: outputs.shift() ?? '[]' }))
    const reconciliations: Array<{ ids: string[]; missing: string[] }> = []
    const poller = new ClaudePoller({
      binaryPath: '/absolute/claude',
      runCommand,
      activityStore: {
        async reconcileClaudeAgents(observations, missing = []) {
          reconciliations.push({
            ids: observations.map((entry) => entry.sessionId),
            missing: [...missing]
          })
        }
      }
    })

    await expect(poller.pollNow()).resolves.toMatchObject({ ok: true, missingSessionIds: [] })
    await expect(poller.pollNow()).resolves.toMatchObject({ ok: false, missingSessionIds: [] })
    await expect(poller.pollNow()).resolves.toMatchObject({
      ok: true,
      missingSessionIds: ['session-1']
    })
    expect(reconciliations).toEqual([
      { ids: ['session-1'], missing: [] },
      { ids: [], missing: ['session-1'] }
    ])
  })

  it('closes older hook-only Claude sessions missing from an authoritative poll', async () => {
    const reconcileClaudeAgents = vi.fn(async () => undefined)
    const poller = new ClaudePoller({
      binaryPath: '/absolute/claude',
      now: () => CLAUDE_RECONCILE_GRACE_MS,
      runCommand: async () => ({ stdout: '[]' }),
      activityStore: {
        getActivities: () => [{
          id: 'claude:hook-only',
          provider: 'claude',
          sessionId: 'hook-only',
          cwd: '/tmp/project',
          projectName: 'project',
          state: 'running',
          summary: 'Claude is working',
          updatedAt: 0,
          unread: false,
          live: true
        }],
        reconcileClaudeAgents
      }
    })

    await expect(poller.pollNow()).resolves.toMatchObject({
      ok: true,
      missingSessionIds: ['hook-only']
    })
    expect(reconcileClaudeAgents).toHaveBeenCalledWith([], ['hook-only'])
  })

  it('classifies ClaudeClaw observations before reconciliation', async () => {
    const reconcileClaudeAgents = vi.fn(async () => undefined)
    const poller = new ClaudePoller({
      binaryPath: '/absolute/claude',
      runCommand: async () => ({
        stdout: JSON.stringify([{
          sessionId: 'claw-session',
          cwd: '/Users/test/assistants/claw',
          kind: 'interactive',
          state: 'working'
        }])
      }),
      classifyObservation: async (observation) => ({
        ...observation,
        provider: 'claudeclaw',
        summary: observation.summary?.replace(/^Claude\b/, 'ClaudeClaw')
      }),
      activityStore: { reconcileClaudeAgents }
    })

    await poller.pollNow()
    expect(reconcileClaudeAgents).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: 'claudeclaw',
        summary: 'ClaudeClaw is working'
      })
    ], [])
  })

  it('requires the capability-tested absolute Claude binary path', () => {
    expect(
      () =>
        new ClaudePoller({
          binaryPath: 'claude',
          activityStore: { reconcileClaudeAgents: async () => undefined }
        })
    ).toThrow(/absolute binary path/)
  })

  it('waits for an in-flight reconciliation before stop resolves', async () => {
    let reconciliationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reconciliationStarted = resolve
    })
    let finishReconciliation!: () => void
    const reconciliationFinished = new Promise<void>((resolve) => {
      finishReconciliation = resolve
    })
    const poller = new ClaudePoller({
      binaryPath: '/absolute/claude',
      intervalMs: 60_000,
      runCommand: async () => ({ stdout: '[]' }),
      activityStore: {
        async reconcileClaudeAgents() {
          reconciliationStarted()
          await reconciliationFinished
        }
      }
    })

    poller.start()
    await started

    let stopResolved = false
    const stopping = poller.stop().then(() => {
      stopResolved = true
    })
    await Promise.resolve()

    expect(poller.isRunning).toBe(false)
    expect(stopResolved).toBe(false)

    finishReconciliation()
    await stopping
    expect(stopResolved).toBe(true)
  })

  it('also waits for a manual poll when no interval was started', async () => {
    let finishCommand!: (result: { stdout: string }) => void
    const command = new Promise<{ stdout: string }>((resolve) => {
      finishCommand = resolve
    })
    const reconcileClaudeAgents = vi.fn(async () => undefined)
    const poller = new ClaudePoller({
      binaryPath: '/absolute/claude',
      runCommand: async () => command,
      activityStore: { reconcileClaudeAgents }
    })

    void poller.pollNow()
    let stopped = false
    const stopping = poller.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    finishCommand({ stdout: '[]' })
    await stopping
    expect(reconcileClaudeAgents).toHaveBeenCalledOnce()
  })
})
