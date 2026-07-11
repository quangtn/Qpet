import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'jsonc-parser'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS,
  IntegrationManager,
  isQPetHookHandler
} from '../src/main/integration-manager'
import type { DiscoveredBinary } from '../src/main/binary-discovery'
import type { Provider } from '../src/shared/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function binary(provider: Provider): DiscoveredBinary {
  return {
    provider,
    path: `/opt/qpet-test/${provider}`,
    version: provider === 'codex' ? 'codex-cli 0.142.4' : '2.1.201',
    capabilities: {
      hooks: true,
      agentsJson: provider === 'claude',
      backgroundAttach: provider === 'claude',
      resume: true
    }
  }
}

function qpetHandlerCount(config: Record<string, unknown>): number {
  const hooks = config.hooks as Record<string, Array<{ hooks?: unknown[] }>> | undefined
  if (!hooks) return 0
  return Object.values(hooks).flat().flatMap((group) => group.hooks ?? []).filter(isQPetHookHandler).length
}

function qpetCursorHandlerCount(config: Record<string, unknown>): number {
  const hooks = config.hooks as Record<string, unknown[]> | undefined
  if (!hooks) return 0
  return Object.values(hooks).flat().filter(isQPetHookHandler).length
}

function parseJsoncObject(source: string): Record<string, unknown> {
  return parse(source) as Record<string, unknown>
}

describe('IntegrationManager', () => {
  it('installs Cursor hooks idempotently and preserves unrelated handlers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-cursor-home-'))
    temporaryDirectories.push(home)
    const cursorDir = join(home, 'cursor-config')
    await mkdir(cursorDir, { recursive: true })
    const existing = { command: '/usr/local/bin/keep-cursor-stop', timeout: 5 }
    await writeFile(
      join(cursorDir, 'hooks.json'),
      JSON.stringify({ custom: true, hooks: { stop: [existing] } })
    )

    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'Library', 'Application Support', 'QPet'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      cursorHooksPath: join(cursorDir, 'hooks.json'),
      isListenerActive: () => true,
      now: () => new Date('2026-07-10T12:34:56.789Z'),
      discover: async () => ({
        codex: binary('codex'),
        claude: binary('claude'),
        cursor: binary('cursor')
      })
    })

    const installed = await manager.install()
    expect(installed.ok).toBe(true)
    expect(installed.status.cursor.health).toBe('healthy')
    const source = await readFile(manager.cursorHooksPath, 'utf8')
    const config = JSON.parse(source)
    expect(config.version).toBe(1)
    expect(config.custom).toBe(true)
    expect(config.hooks.stop).toContainEqual(existing)
    expect(qpetCursorHandlerCount(config)).toBe(CURSOR_HOOK_EVENTS.length)
    expect((await readdir(cursorDir)).filter((name) => name.includes('.qpet-backup-'))).toHaveLength(1)

    await manager.install()
    expect(await readFile(manager.cursorHooksPath, 'utf8')).toBe(source)
    expect((await readdir(cursorDir)).filter((name) => name.includes('.qpet-backup-'))).toHaveLength(1)

    await manager.uninstall()
    const removed = JSON.parse(await readFile(manager.cursorHooksPath, 'utf8'))
    expect(removed.custom).toBe(true)
    expect(removed.hooks.stop).toEqual([existing])
    expect(qpetCursorHandlerCount(removed)).toBe(0)
  })

  it('installs idempotently, backs up, and removes only QPet handlers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-home-'))
    temporaryDirectories.push(home)
    const codexDir = join(home, '.codex')
    const claudeDir = join(home, '.claude')
    await Promise.all([
      mkdir(codexDir, { recursive: true }),
      mkdir(claudeDir, { recursive: true })
    ])

    const existingCodexHandler = {
      type: 'command',
      command: '/usr/local/bin/existing-codex-hook'
    }
    const existingClaudeHandler = {
      type: 'command',
      command: '/usr/local/bin/existing-claude-hook'
    }
    await writeFile(
      join(codexDir, 'hooks.json'),
      JSON.stringify({
        owner: 'user',
        hooks: {
          Stop: [{ hooks: [existingCodexHandler] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [existingCodexHandler] }]
        }
      })
    )
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: { SessionEnd: [{ matcher: '*', hooks: [existingClaudeHandler] }] }
      })
    )
    const configToml = 'notify = ["computer-use-notify"]\n[features]\nhooks = true\n'
    await writeFile(join(codexDir, 'config.toml'), configToml)

    const appSupport = join(home, 'Library', 'Application Support', 'QPet')
    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: appSupport,
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => true,
      now: () => new Date('2026-07-10T12:34:56.789Z'),
      discover: async () => ({ codex: binary('codex'), claude: binary('claude') })
    })

    const first = await manager.install()
    expect(first.ok).toBe(true)
    expect(first.status.codex.health).toBe('awaiting_trust')
    expect(first.status.claude.health).toBe('healthy')

    const codexInstalled = JSON.parse(await readFile(manager.codexHooksPath, 'utf8'))
    const claudeInstalled = JSON.parse(await readFile(manager.claudeSettingsPath, 'utf8'))
    expect(qpetHandlerCount(codexInstalled)).toBe(CODEX_HOOK_EVENTS.length)
    expect(qpetHandlerCount(claudeInstalled)).toBe(CLAUDE_HOOK_EVENTS.length)
    expect(codexInstalled.owner).toBe('user')
    expect(codexInstalled.hooks.PreToolUse[0].hooks).toContainEqual(existingCodexHandler)
    expect(claudeInstalled.permissions).toEqual({ allow: ['Read'] })
    expect(claudeInstalled.hooks.SessionEnd[0].hooks).toContainEqual(existingClaudeHandler)
    expect(await readFile(join(codexDir, 'config.toml'), 'utf8')).toBe(configToml)
    await expect(access(manager.helperPath, fsConstants.X_OK)).resolves.toBeUndefined()

    const firstCodexContents = await readFile(manager.codexHooksPath, 'utf8')
    const firstClaudeContents = await readFile(manager.claudeSettingsPath, 'utf8')
    const firstBackups = [
      ...(await readdir(codexDir)).filter((name) => name.includes('.qpet-backup-')),
      ...(await readdir(claudeDir)).filter((name) => name.includes('.qpet-backup-'))
    ]
    expect(firstBackups).toHaveLength(2)

    const second = await manager.install()
    expect(second.ok).toBe(true)
    expect(await readFile(manager.codexHooksPath, 'utf8')).toBe(firstCodexContents)
    expect(await readFile(manager.claudeSettingsPath, 'utf8')).toBe(firstClaudeContents)
    const secondBackups = [
      ...(await readdir(codexDir)).filter((name) => name.includes('.qpet-backup-')),
      ...(await readdir(claudeDir)).filter((name) => name.includes('.qpet-backup-'))
    ]
    expect(secondBackups).toEqual(firstBackups)

    const trusted = await manager.markCodexTrusted()
    expect(trusted.codex.health).toBe('healthy')

    const removed = await manager.uninstall()
    expect(removed.ok).toBe(true)
    const codexRemoved = JSON.parse(await readFile(manager.codexHooksPath, 'utf8'))
    const claudeRemoved = JSON.parse(await readFile(manager.claudeSettingsPath, 'utf8'))
    expect(qpetHandlerCount(codexRemoved)).toBe(0)
    expect(qpetHandlerCount(claudeRemoved)).toBe(0)
    expect(codexRemoved.hooks.Stop[0].hooks).toEqual([existingCodexHandler])
    expect(codexRemoved.hooks.PreToolUse[0].hooks).toEqual([existingCodexHandler])
    expect(claudeRemoved.hooks.SessionEnd[0].hooks).toEqual([existingClaudeHandler])
    expect(claudeRemoved.permissions).toEqual({ allow: ['Read'] })
    expect(await readFile(join(codexDir, 'config.toml'), 'utf8')).toBe(configToml)
    await expect(access(manager.helperPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves comments, unrelated settings, and unrelated hooks through install and uninstall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-jsonc-home-'))
    temporaryDirectories.push(home)
    const codexDir = join(home, '.codex')
    const claudeDir = join(home, '.claude')
    await Promise.all([
      mkdir(codexDir, { recursive: true }),
      mkdir(claudeDir, { recursive: true })
    ])

    const codexSource = `{
  // Keep this owner note.
  "owner": "user",
  "hooks": {
    // This event is outside QPet's lifecycle set.
    "PreCompact": [
      {
        "matcher": "manual",
        "hooks": [
          // Keep this unrelated hook comment.
          { "type": "command", "command": "/usr/local/bin/keep-precompact" },
        ],
      },
    ],
    "Stop": [
      {
        "hooks": [
          // Keep this existing Stop hook comment.
          { "type": "command", "command": "/usr/local/bin/keep-codex-stop" },
        ],
      },
    ],
  },
}
`
    const claudeSource = `{
  // Keep this permissions note.
  "permissions": {
    "allow": ["Read"],
  },
  "hooks": {
    // This event is outside QPet's lifecycle set.
    "ConfigChange": [
      {
        "matcher": "user_settings",
        "hooks": [
          // Keep this unrelated hook comment.
          { "type": "command", "command": "/usr/local/bin/keep-config-change" },
        ],
      },
    ],
    "SessionEnd": [
      {
        "matcher": "logout",
        "hooks": [
          // Keep this existing SessionEnd hook comment.
          { "type": "command", "command": "/usr/local/bin/keep-claude-end" },
        ],
      },
    ],
  },
}
`
    await Promise.all([
      writeFile(join(codexDir, 'hooks.json'), codexSource),
      writeFile(join(claudeDir, 'settings.json'), claudeSource)
    ])

    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'Library', 'Application Support', 'QPet'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => true,
      now: () => new Date('2026-07-10T12:34:56.789Z'),
      discover: async () => ({ codex: binary('codex'), claude: binary('claude') })
    })

    const installed = await manager.install()
    expect(installed.ok).toBe(true)
    const installedCodexSource = await readFile(manager.codexHooksPath, 'utf8')
    const installedClaudeSource = await readFile(manager.claudeSettingsPath, 'utf8')
    expect(installedCodexSource).toContain('// Keep this owner note.')
    expect(installedCodexSource).toContain('// Keep this unrelated hook comment.')
    expect(installedCodexSource).toContain('// Keep this existing Stop hook comment.')
    expect(installedClaudeSource).toContain('// Keep this permissions note.')
    expect(installedClaudeSource).toContain('// Keep this unrelated hook comment.')
    expect(installedClaudeSource).toContain('// Keep this existing SessionEnd hook comment.')

    const installedCodex = parseJsoncObject(installedCodexSource)
    const installedClaude = parseJsoncObject(installedClaudeSource)
    expect(installedCodex.owner).toBe('user')
    expect(installedCodexSource).toContain('/usr/local/bin/keep-precompact')
    expect(installedCodexSource).toContain('/usr/local/bin/keep-codex-stop')
    expect(installedClaude.permissions).toEqual({ allow: ['Read'] })
    expect(installedClaudeSource).toContain('/usr/local/bin/keep-config-change')
    expect(installedClaudeSource).toContain('/usr/local/bin/keep-claude-end')
    expect(qpetHandlerCount(installedCodex)).toBe(CODEX_HOOK_EVENTS.length)
    expect(qpetHandlerCount(installedClaude)).toBe(CLAUDE_HOOK_EVENTS.length)

    const reinstalled = await manager.install()
    expect(reinstalled.ok).toBe(true)
    expect(await readFile(manager.codexHooksPath, 'utf8')).toBe(installedCodexSource)
    expect(await readFile(manager.claudeSettingsPath, 'utf8')).toBe(installedClaudeSource)

    const removed = await manager.uninstall()
    expect(removed.ok).toBe(true)
    const removedCodexSource = await readFile(manager.codexHooksPath, 'utf8')
    const removedClaudeSource = await readFile(manager.claudeSettingsPath, 'utf8')
    expect(removedCodexSource).toContain('// Keep this owner note.')
    expect(removedCodexSource).toContain('// Keep this unrelated hook comment.')
    expect(removedCodexSource).toContain('// Keep this existing Stop hook comment.')
    expect(removedClaudeSource).toContain('// Keep this permissions note.')
    expect(removedClaudeSource).toContain('// Keep this unrelated hook comment.')
    expect(removedClaudeSource).toContain('// Keep this existing SessionEnd hook comment.')
    expect(removedCodexSource).toContain('/usr/local/bin/keep-precompact')
    expect(removedCodexSource).toContain('/usr/local/bin/keep-codex-stop')
    expect(removedClaudeSource).toContain('/usr/local/bin/keep-config-change')
    expect(removedClaudeSource).toContain('/usr/local/bin/keep-claude-end')
    expect(qpetHandlerCount(parseJsoncObject(removedCodexSource))).toBe(0)
    expect(qpetHandlerCount(parseJsoncObject(removedClaudeSource))).toBe(0)
  })

  it('refuses to overwrite invalid user settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-invalid-home-'))
    temporaryDirectories.push(home)
    await mkdir(join(home, '.claude'), { recursive: true })
    const settingsPath = join(home, '.claude', 'settings.json')
    const invalid = '{ "hooks": '
    await writeFile(settingsPath, invalid)

    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'support'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => true,
      discover: async () => ({ codex: binary('codex'), claude: binary('claude') })
    })
    const result = await manager.install()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('invalid JSON')
    expect(await readFile(settingsPath, 'utf8')).toBe(invalid)
  })

  it('installs hooks only for detected providers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-provider-aware-'))
    temporaryDirectories.push(home)
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), '{ "hooks": ')

    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'Library', 'Application Support', 'QPet'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => true,
      now: () => new Date('2026-07-10T12:34:56.789Z'),
      discover: async () => ({ codex: binary('codex') })
    })

    const installed = await manager.install()
    expect(installed.ok).toBe(true)
    expect(installed.message).toContain('Codex')
    expect(installed.message).not.toContain('Claude Code')
    expect(installed.status.codex.health).toBe('awaiting_trust')
    expect(qpetHandlerCount(JSON.parse(await readFile(manager.codexHooksPath, 'utf8')))).toBe(
      CODEX_HOOK_EVENTS.length
    )
    await expect(access(manager.cursorHooksPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ "hooks": ')
  })

  it('reports when no provider CLIs are available to install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-no-providers-'))
    temporaryDirectories.push(home)
    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'support'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => true,
      discover: async () => ({})
    })

    const result = await manager.install()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/No supported/)
  })

  it('exposes a listener message when the event listener is down', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qpet-listener-down-'))
    temporaryDirectories.push(home)
    const manager = new IntegrationManager({
      homeDir: home,
      appSupportDir: join(home, 'support'),
      helperSourcePath: resolve('resources/qpet-hook.sh'),
      isListenerActive: () => false,
      listenerMessage: () => 'QPet’s local event listener failed to start: EADDRINUSE',
      discover: async () => ({ codex: binary('codex') })
    })

    const status = await manager.getStatus()
    expect(status.listenerActive).toBe(false)
    expect(status.listenerMessage).toContain('EADDRINUSE')
  })
})
