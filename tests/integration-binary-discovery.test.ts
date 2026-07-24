import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  discoverBinaries,
  discoverBinary,
  type CommandRunner
} from '../src/main/binary-discovery'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function fakeExecutable(directory: string, name: string): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
  return path
}

describe('binary discovery', () => {
  it('finds absolute executables and capability-tests both providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qpet-binaries-'))
    temporaryDirectories.push(root)
    const bin = join(root, 'bin')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin))
    const codexPath = await realpath(await fakeExecutable(bin, 'codex'))
    const claudePath = await realpath(await fakeExecutable(bin, 'claude'))
    const cursorPath = await realpath(await fakeExecutable(bin, 'cursor'))
    const hermesPath = await realpath(await fakeExecutable(bin, 'hermes'))

    const runner: CommandRunner = vi.fn(async (executable, args) => {
      if (executable === codexPath && args[0] === '--version') {
        return { stdout: 'codex-cli 0.142.4\n', stderr: '' }
      }
      if (executable === codexPath && args.join(' ') === 'features list') {
        return { stdout: 'hooks  stable  true\n', stderr: '' }
      }
      if (executable === codexPath && args.join(' ') === 'resume --help') {
        return { stdout: 'Resume a previous session\n', stderr: '' }
      }
      if (executable === claudePath && args[0] === '--version') {
        return { stdout: '2.1.201 (Claude Code)\n', stderr: '' }
      }
      if (executable === claudePath && args.join(' ') === 'agents --json') {
        return { stdout: '[]', stderr: '' }
      }
      if (executable === claudePath && args.join(' ') === 'attach --help') {
        return { stdout: 'Usage: claude attach <id>\n', stderr: '' }
      }
      if (executable === claudePath && args[0] === '--help') {
        return {
          stdout: '  --resume [value]\n  --settings <file-or-json>\n  --setting-sources <sources>\n',
          stderr: ''
        }
      }
      if (executable === cursorPath && args[0] === '--version') {
        return { stdout: '3.11.13\n', stderr: '' }
      }
      if (executable === hermesPath && args[0] === '--version') {
        return { stdout: 'Hermes Agent v0.19.0\n', stderr: '' }
      }
      if (executable === hermesPath && args.join(' ') === 'hooks --help') {
        return { stdout: 'Inspect and manage shell-script hooks\n', stderr: '' }
      }
      if (executable === hermesPath && args[0] === '--help') {
        return { stdout: '  --resume SESSION\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${executable} ${args.join(' ')}`)
    })

    const binaries = await discoverBinaries({
      homeDir: root,
      pathEnv: '',
      candidateDirectories: [bin],
      runCommand: runner
    })

    expect(binaries.codex).toMatchObject({
      path: codexPath,
      version: 'codex-cli 0.142.4',
      capabilities: { hooks: true, resume: true }
    })
    expect(binaries.claude).toMatchObject({
      path: claudePath,
      version: '2.1.201 (Claude Code)',
      capabilities: {
        hooks: true,
        agentsJson: true,
        backgroundAttach: true,
        resume: true
      }
    })
    expect(binaries.cursor).toMatchObject({
      path: cursorPath,
      version: '3.11.13',
      capabilities: { hooks: true, resume: false }
    })
    expect(binaries.hermes).toMatchObject({
      path: hermesPath,
      version: 'Hermes Agent v0.19.0',
      capabilities: { hooks: true, resume: true }
    })
    expect(runner).not.toHaveBeenCalledWith(cursorPath, ['agent', '--help'], expect.any(Number))
  })

  it('keeps individual failed capability probes fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qpet-binary-failure-'))
    temporaryDirectories.push(root)
    const bin = join(root, 'bin')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(bin))
    await fakeExecutable(bin, 'claude')

    const result = await discoverBinary('claude', {
      homeDir: root,
      pathEnv: '',
      candidateDirectories: [bin],
      runCommand: async (_executable, args) => {
        if (args[0] === '--version') return { stdout: '2.1.201\n', stderr: '' }
        throw new Error('unsupported')
      }
    })

    expect(result?.capabilities).toEqual({
      hooks: false,
      agentsJson: false,
      backgroundAttach: false,
      resume: false
    })
  })
})
