import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ACTIVITY_RETENTION_MS,
  ActivityStore,
  CODEX_STALE_AFTER_MS,
  CURSOR_STALE_AFTER_MS
} from '../src/main/activity-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function makeStore(now: () => number): Promise<{ store: ActivityStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'qpet-activity-'))
  temporaryDirectories.push(directory)
  const store = new ActivityStore({ supportDir: directory, now })
  await store.initialize()
  return { store, directory }
}

describe('ActivityStore', () => {
  it('persists only normalized fields and reloads the cache', async () => {
    const { store, directory } = await makeStore(() => 100)
    await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'DO NOT PERSIST THIS PROMPT',
      tool_input: { command: 'DO NOT PERSIST THIS COMMAND' },
      transcript_path: '/private/transcript.jsonl',
      last_assistant_message: 'DO NOT PERSIST THIS RESPONSE'
    })

    const persisted = await readFile(join(directory, 'activities.json'), 'utf8')
    expect(persisted).not.toContain('DO NOT PERSIST')
    expect(persisted).not.toContain('transcript')
    expect(Object.keys(JSON.parse(persisted).activities[0]).sort()).toEqual(
      [
        'cwd',
        'id',
        'live',
        'projectName',
        'provider',
        'sessionId',
        'state',
        'summary',
        'unread',
        'updatedAt'
      ].sort()
    )

    const reloaded = new ActivityStore({ supportDir: directory, now: () => 101 })
    await reloaded.initialize()
    expect(reloaded.getActivities()).toEqual(store.getActivities())
  })

  it('deduplicates overlapping Claude permission hooks', async () => {
    let now = 1_000
    const { store } = await makeStore(() => now)
    const permission = await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'PermissionRequest',
      tool_input: { command: 'private' }
    })
    now += 100
    const notification = await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'private permission text'
    })

    expect(permission).toMatchObject({ changed: true, duplicate: false })
    expect(notification).toMatchObject({ changed: false, duplicate: true })
    expect(store.getActivities()).toHaveLength(1)
    expect(store.getActivities()[0].updatedAt).toBe(1_000)
  })

  it('closes Claude sessions without losing a prior failure state', async () => {
    let now = 1
    const { store } = await makeStore(() => now)
    await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'StopFailure',
      error: 'private API response'
    })
    now = 2
    await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'SessionEnd',
      reason: 'other'
    })

    expect(store.getActivities()[0]).toMatchObject({
      state: 'blocked',
      summary: 'Claude could not finish',
      live: false,
      updatedAt: 2
    })
  })

  it('reconciles agent liveness without overwriting a hook-derived ready state', async () => {
    let now = 1
    const { store } = await makeStore(() => now)
    await store.ingest('claude', {
      session_id: 'session-1',
      cwd: '/tmp/project',
      hook_event_name: 'Stop'
    })

    await store.reconcileClaudeAgents([
      {
        provider: 'claude',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        projectName: 'project',
        live: true,
        observedAt: 20
      }
    ])
    expect(store.getActivities()[0]).toMatchObject({
      state: 'ready',
      summary: 'Claude finished',
      updatedAt: 1,
      live: true
    })

    now = 30
    await store.reconcileClaudeAgents([], ['session-1'])
    expect(store.getActivities()[0]).toMatchObject({ state: 'ready', live: false })
  })

  it('expires stale Codex work after 24 hours and completed history after seven days', async () => {
    let now = 0
    const { store } = await makeStore(() => now)
    await store.ingest('codex', {
      session_id: 'running',
      cwd: '/tmp/project',
      hook_event_name: 'UserPromptSubmit'
    })
    await store.ingest('claude', {
      session_id: 'ready',
      cwd: '/tmp/project',
      hook_event_name: 'Stop'
    })

    now = CODEX_STALE_AFTER_MS
    expect(await store.cleanup()).toBe(1)
    expect(store.getActivities().map((activity) => activity.sessionId)).toEqual(['ready'])

    now = ACTIVITY_RETENTION_MS
    expect(await store.cleanup()).toBe(1)
    expect(store.getActivities()).toEqual([])
  })

  it('expires orphaned Cursor work after two hours without lifecycle updates', async () => {
    let now = 0
    const { store } = await makeStore(() => now)
    await store.ingest('cursor', {
      conversation_id: 'orphaned-cursor',
      cwd: '/tmp/project',
      hook_event_name: 'beforeSubmitPrompt'
    })
    expect(store.getActivities()).toHaveLength(1)

    now = CURSOR_STALE_AFTER_MS
    expect(await store.cleanup()).toBe(1)
    expect(store.getActivities()).toEqual([])
  })

  it('marks all ready activities read when no id is supplied', async () => {
    const { store } = await makeStore(() => 1)
    await store.ingest('claude', {
      session_id: 'ready',
      cwd: '/tmp/project',
      hook_event_name: 'Stop'
    })
    await store.ingest('codex', {
      session_id: 'input',
      cwd: '/tmp/project',
      hook_event_name: 'PermissionRequest'
    })

    await store.markRead()
    expect(store.getActivity('claude:ready')?.unread).toBe(false)
    expect(store.getActivity('codex:input')?.unread).toBe(true)
  })
})
