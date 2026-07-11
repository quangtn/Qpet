import { describe, expect, it } from 'vitest'

import {
  normalizeClaudeAgent,
  normalizeClaudeEvent,
  normalizeCodexEvent,
  normalizeCursorEvent,
  sortActivities
} from '../src/main/provider-normalizers'
import type { Activity } from '../src/shared/contracts'

describe('provider event normalizers', () => {
  it('does not claim that an idle session is working at registration time', () => {
    const base = { session_id: 'session-1', cwd: '/tmp/project', hook_event_name: 'SessionStart' }
    expect(normalizeCodexEvent(base)).toBeNull()
    expect(normalizeClaudeEvent(base)).toBeNull()
    expect(normalizeCursorEvent({
      conversation_id: 'cursor-1',
      workspace_roots: ['/tmp/project'],
      hook_event_name: 'sessionStart'
    })).toBeNull()
  })

  it('maps Cursor lifecycle events without retaining prompts or responses', () => {
    const base = {
      conversation_id: 'cursor-1',
      workspace_roots: ['/Users/test/cursor-project']
    }
    const working = normalizeCursorEvent({
      ...base,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'TOP SECRET CURSOR PROMPT'
    }, 321)
    expect(working).toMatchObject({
      id: 'cursor:cursor-1',
      provider: 'cursor',
      projectName: 'cursor-project',
      state: 'running',
      summary: 'Cursor is working',
      updatedAt: 321,
      unread: false,
      live: true
    })
    expect(JSON.stringify(working)).not.toContain('TOP SECRET')
    expect(normalizeCursorEvent({ ...base, hook_event_name: 'afterAgentResponse' })).toMatchObject({
      state: 'ready',
      summary: 'Cursor finished',
      unread: true,
      live: false
    })
    expect(normalizeCursorEvent({ ...base, hook_event_name: 'stop' })).toMatchObject({
      state: 'ready',
      summary: 'Cursor finished',
      unread: true,
      live: false
    })
    expect(normalizeCursorEvent({ ...base, hook_event_name: 'sessionEnd' })).toMatchObject({
      state: 'ready',
      live: false,
      close: true
    })
    expect(normalizeCursorEvent({ ...base, hook_event_name: 'postToolUseFailure' })).toBeNull()
  })

  it('maps Codex lifecycle events without retaining prompts or commands', () => {
    const event = normalizeCodexEvent(
      {
        session_id: 'codex-1',
        cwd: '/Users/test/secret-project',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'TOP SECRET PROMPT',
        tool_input: { command: 'rm -rf TOP-SECRET' },
        last_assistant_message: 'TOP SECRET RESPONSE'
      },
      123
    )

    expect(event).toMatchObject({
      id: 'codex:codex-1',
      provider: 'codex',
      sessionId: 'codex-1',
      projectName: 'secret-project',
      state: 'running',
      summary: 'Codex is working',
      updatedAt: 123,
      unread: false,
      live: true
    })
    expect(JSON.stringify(event)).not.toContain('TOP SECRET')
  })

  it('maps approval requests and returns to working after recoverable tool output', () => {
    expect(
      normalizeCodexEvent({
        session_id: 'codex-1',
        cwd: '/tmp/project',
        hook_event_name: 'PermissionRequest',
        tool_input: { command: 'private command' }
      })
    ).toMatchObject({ state: 'needs_input', summary: 'Codex needs approval' })

    expect(
      normalizeCodexEvent({
        session_id: 'codex-1',
        cwd: '/tmp/project',
        hook_event_name: 'PostToolUseFailure',
        tool_response: { exitCode: 1, output: 'private output' }
      })
    ).toBeNull()
    expect(
      normalizeCodexEvent({
        session_id: 'codex-1',
        cwd: '/tmp/project',
        hook_event_name: 'PostToolUse',
        tool_response: { exitCode: 1, output: 'private output' }
      })
    ).toMatchObject({ state: 'running', summary: 'Codex is working', unread: false })

    expect(
      normalizeCodexEvent({
        session_id: 'codex-1',
        cwd: '/tmp/project',
        hook_event_name: 'Stop'
      })
    ).toMatchObject({ state: 'ready', summary: 'Codex finished', unread: true, live: false })
  })

  it('maps Claude question, completion, API failure, and close events', () => {
    const base = { session_id: 'claude-1', cwd: '/tmp/project' }

    expect(
      normalizeClaudeEvent({
        ...base,
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'private question'
      })
    ).toMatchObject({ state: 'needs_input', summary: 'Claude needs input' })
    expect(normalizeClaudeEvent({ ...base, hook_event_name: 'Stop' })).toMatchObject({
      state: 'ready',
      summary: 'Claude finished'
    })
    expect(
      normalizeClaudeEvent({
        ...base,
        hook_event_name: 'StopFailure',
        error: 'sk-ant-secret provider response'
      })
    ).toMatchObject({ state: 'blocked', summary: 'Claude could not finish' })
    expect(
      JSON.stringify(
        normalizeClaudeEvent({
          ...base,
          hook_event_name: 'StopFailure',
          error: 'sk-ant-secret provider response'
        })
      )
    ).not.toContain('sk-ant-secret')
    expect(normalizeClaudeEvent({ ...base, hook_event_name: 'SessionEnd' })).toMatchObject({
      state: 'ready',
      live: false,
      close: true
    })
  })

  it('maps AskUserQuestion and keeps Stop running while background work remains', () => {
    const base = { session_id: 'claude-1', cwd: '/tmp/project' }
    expect(
      normalizeClaudeEvent({
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'private question' }] }
      })
    ).toMatchObject({ state: 'needs_input', summary: 'Claude needs an answer' })
    expect(
      JSON.stringify(
        normalizeClaudeEvent({
          ...base,
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'private question' }] }
        })
      )
    ).not.toContain('private question')

    expect(
      normalizeClaudeEvent({
        ...base,
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'private-background-task' }]
      })
    ).toMatchObject({ state: 'running', summary: 'Claude is still working', unread: false })

    expect(
      normalizeClaudeEvent({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_response: { answers: { private: 'discarded' } }
      })
    ).toMatchObject({ state: 'running', summary: 'Claude is working', unread: false })
  })

  it('normalizes live Claude agent observations without names or output', () => {
    const observation = normalizeClaudeAgent(
      {
        id: 'job-123',
        sessionId: 'session-123',
        cwd: '/Users/test/project',
        kind: 'background',
        state: 'blocked',
        name: 'private generated task name',
        summary: 'private agent output'
      },
      456
    )

    expect(observation).toEqual({
      provider: 'claude',
      sessionId: 'session-123',
      cwd: '/Users/test/project',
      projectName: 'project',
      state: 'needs_input',
      summary: 'Claude needs input',
      live: true,
      backgroundJobId: 'job-123',
      observedAt: 456
    })
  })

  it('sorts activity using the pet-state priority before recency', () => {
    const make = (state: Activity['state'], updatedAt: number): Activity => ({
      id: state,
      provider: 'claude',
      sessionId: state,
      cwd: '/tmp/project',
      projectName: 'project',
      state,
      summary: state,
      updatedAt,
      unread: false,
      live: true
    })

    expect(
      sortActivities([
        make('running', 10_000),
        make('ready', 2),
        make('needs_input', 1),
        make('blocked', 3)
      ]).map((activity) => activity.state)
    ).toEqual(['needs_input', 'blocked', 'running', 'ready'])
  })
})
