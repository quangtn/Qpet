import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeClawDiscovery } from '../src/main/claudeclaw-discovery'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function fixture(): Promise<{
  home: string
  workspace: string
  discovery: ClaudeClawDiscovery
}> {
  const home = await mkdtemp(join(tmpdir(), 'qpet-claw-home-'))
  temporaryDirectories.push(home)
  const workspace = join(home, 'assistants', 'claw')
  const runtime = join(workspace, '.claude', 'claudeclaw')
  const launchAgents = join(home, 'Library', 'LaunchAgents')
  await Promise.all([
    mkdir(runtime, { recursive: true }),
    mkdir(launchAgents, { recursive: true })
  ])
  await Promise.all([
    writeFile(join(runtime, 'daemon.pid'), '4242\n'),
    writeFile(join(runtime, 'state.json'), JSON.stringify({
      jobs: [],
      web: { enabled: true, host: '127.0.0.1', port: 4632 }
    })),
    writeFile(join(runtime, 'web.token'), 'DO NOT READ THIS TOKEN'),
    writeFile(join(runtime, 'logs'), 'DO NOT READ THIS LOG'),
    writeFile(
      join(launchAgents, 'com.claudeclaw.test.plist'),
      `<?xml version="1.0"?><plist><dict>
        <key>WorkingDirectory</key><string>${workspace}</string>
      </dict></plist>`
    )
  ])
  await chmod(join(runtime, 'web.token'), 0o000)
  await chmod(join(runtime, 'logs'), 0o000)

  return {
    home,
    workspace,
    discovery: new ClaudeClawDiscovery({
      homeDir: home,
      processAlive: (pid) => pid === 4242
    })
  }
}

describe('ClaudeClawDiscovery', () => {
  it('discovers launch-agent workspaces and exposes only safe runtime metadata', async () => {
    const { workspace, discovery } = await fixture()
    await expect(discovery.refresh()).resolves.toEqual([
      {
        root: workspace,
        running: true,
        webUrl: 'http://127.0.0.1:4632'
      }
    ])
    await expect(
      discovery.resolveWorkspace(join(workspace, 'agents', 'research'))
    ).resolves.toMatchObject({ root: workspace, running: true })
  })

  it('reclassifies only Claude events within a marked workspace', async () => {
    const { workspace, discovery } = await fixture()
    await discovery.refresh()
    await expect(discovery.providerForEvent('claude', {
      session_id: 'one',
      cwd: join(workspace, 'agents', 'worker')
    })).resolves.toBe('claudeclaw')
    await expect(discovery.providerForEvent('claude', {
      session_id: 'two',
      cwd: join(dirname(workspace), 'ordinary')
    })).resolves.toBe('claude')
    await expect(discovery.providerForEvent('hermes', {
      session_id: 'three',
      cwd: workspace
    })).resolves.toBe('hermes')
  })

  it('rejects non-loopback dashboard metadata and stale daemons', async () => {
    const { workspace, discovery } = await fixture()
    await writeFile(
      join(workspace, '.claude', 'claudeclaw', 'state.json'),
      JSON.stringify({ web: { enabled: true, host: 'example.com', port: 443 } })
    )
    const stale = new ClaudeClawDiscovery({
      homeDir: discovery.homeDir,
      processAlive: () => false
    })
    await expect(stale.refresh()).resolves.toEqual([
      { root: workspace, running: false }
    ])
  })
})
