import { describe, expect, it, vi } from 'vitest'

import type { Activity } from '../src/shared/contracts'
import {
  TERMINAL_APPLESCRIPT,
  appleScriptArguments,
  buildCopyableCommand,
  buildSessionCommand,
  performSessionAction,
  shellQuote
} from '../src/main/session-actions'
import type { DiscoveredBinary } from '../src/main/binary-discovery'

function activity(patch: Partial<Activity> = {}): Activity {
  return {
    id: 'claude:session-1',
    provider: 'claude',
    sessionId: 'session-1',
    cwd: "/tmp/Quang's project",
    projectName: 'project',
    state: 'ready',
    summary: 'Ready',
    updatedAt: Date.now(),
    unread: true,
    live: false,
    ...patch
  }
}

const claude: DiscoveredBinary = {
  provider: 'claude',
  path: "/Applications/Claude's Tools/claude",
  version: '2.1.201',
  capabilities: { hooks: true, agentsJson: true, backgroundAttach: true, resume: true }
}

const codex: DiscoveredBinary = {
  provider: 'codex',
  path: '/opt/homebrew/bin/codex',
  version: 'codex-cli 0.142.4',
  capabilities: { hooks: true, agentsJson: false, backgroundAttach: false, resume: true }
}

const hermes: DiscoveredBinary = {
  provider: 'hermes',
  path: "/Users/test/Hermes' tools/hermes",
  version: 'Hermes Agent v0.19.0',
  capabilities: { hooks: true, agentsJson: false, backgroundAttach: false, resume: true }
}

describe('session actions', () => {
  it('quotes every shell value, including apostrophes', () => {
    expect(shellQuote("a'b; $(touch nope)")).toBe("'a'\\''b; $(touch nope)'")
    expect(buildSessionCommand(activity(), 'resume', { claude })).toBe(
      "'/Applications/Claude'\\''s Tools/claude' --resume 'session-1'"
    )
    expect(buildSessionCommand(
      activity({ provider: 'hermes', id: 'hermes:session-1' }),
      'resume',
      { hermes }
    )).toBe("'/Users/test/Hermes'\\'' tools/hermes' --resume 'session-1'")
  })

  it('attaches only to Claude background jobs', () => {
    expect(
      buildSessionCommand(activity({ live: true, backgroundJobId: 'job-123' }), 'attach', {
        claude
      })
    ).toContain(" attach 'job-123'")
    expect(() =>
      buildSessionCommand(
        activity({ provider: 'codex', backgroundJobId: 'job-123' }),
        'attach',
        { codex }
      )
    ).toThrow('Only Claude background jobs')
  })

  it('never resumes a session known to be live', async () => {
    const runAppleScript = vi.fn(async () => undefined)
    const result = await performSessionAction(activity({ live: true }), 'resume', {
      binaries: { claude },
      runAppleScript
    })

    expect(result).toMatchObject({ ok: false, message: 'A live session cannot be resumed' })
    expect(runAppleScript).not.toHaveBeenCalled()
  })

  it('passes the directory and command as separate AppleScript argv values', async () => {
    const runAppleScript = vi.fn(async () => undefined)
    const target = activity({ sessionId: "id'; display dialog \"nope\"" })
    const result = await performSessionAction(target, 'resume', {
      binaries: { claude },
      runAppleScript
    })

    expect(result.ok).toBe(true)
    expect(runAppleScript).toHaveBeenCalledWith(TERMINAL_APPLESCRIPT, [
      target.cwd,
      expect.stringContaining("--resume 'id'\\''; display dialog \"nope\"'")
    ])
    expect(TERMINAL_APPLESCRIPT).not.toContain(target.cwd)
    expect(appleScriptArguments('script', ['-leading-path', 'command'])).toEqual([
      '-e',
      'script',
      '--',
      '-leading-path',
      'command'
    ])
  })

  it('copies only a directory command for an unattachable live session', async () => {
    const copyText = vi.fn()
    const target = activity({ live: true })
    expect(buildCopyableCommand(target, { claude })).toBe("cd '/tmp/Quang'\\''s project'")

    const result = await performSessionAction(target, 'copy_command', {
      binaries: { claude },
      copyText
    })
    expect(result.ok).toBe(true)
    expect(copyText).toHaveBeenCalledWith("cd '/tmp/Quang'\\''s project'")
  })

  it('opens only the supplied project directory', async () => {
    const openPath = vi.fn(async () => '')
    const target = activity()
    const result = await performSessionAction(target, 'open_project', {
      binaries: {},
      openPath
    })
    expect(result.ok).toBe(true)
    expect(openPath).toHaveBeenCalledWith(target.cwd)
  })

  it('opens ClaudeClaw through its validated workspace dashboard', async () => {
    const openExternal = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => '')
    const target = activity({
      id: 'claudeclaw:session-1',
      provider: 'claudeclaw',
      cwd: '/Users/test/assistants/claw/agents/research'
    })
    const result = await performSessionAction(target, 'open_provider', {
      binaries: {},
      openExternal,
      openPath,
      resolveClaudeClaw: async () => ({
        root: '/Users/test/assistants/claw',
        running: true,
        webUrl: 'http://127.0.0.1:4632'
      })
    })

    expect(result).toEqual({ ok: true, message: 'ClaudeClaw dashboard opened.' })
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:4632')
    expect(openPath).not.toHaveBeenCalled()
    expect(() => buildSessionCommand(target, 'resume', {})).toThrow(
      'managed by the daemon'
    )
    expect(buildCopyableCommand(target, {})).toBe(
      "cd '/Users/test/assistants/claw/agents/research'"
    )
  })

  it('falls back to the ClaudeClaw workspace without reading a dashboard token', async () => {
    const openPath = vi.fn(async () => '')
    const result = await performSessionAction(
      activity({ id: 'claudeclaw:one', provider: 'claudeclaw' }),
      'open_provider',
      {
        binaries: {},
        openPath,
        resolveClaudeClaw: async () => ({
          root: '/Users/test/assistants/claw',
          running: false
        })
      }
    )
    expect(result.ok).toBe(true)
    expect(openPath).toHaveBeenCalledWith('/Users/test/assistants/claw')
  })
})
