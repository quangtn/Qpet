import { constants as fsConstants } from 'node:fs'
import { access, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'

import type { Provider } from '../shared/contracts'

export type BinaryProvider = Exclude<Provider, 'claudeclaw'>

export interface BinaryCapabilities {
  hooks: boolean
  agentsJson: boolean
  backgroundAttach: boolean
  resume: boolean
}

export interface DiscoveredBinary {
  provider: BinaryProvider
  path: string
  version?: string
  capabilities: BinaryCapabilities
}

export interface CommandResult {
  stdout: string
  stderr: string
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<CommandResult>

export interface BinaryDiscoveryOptions {
  homeDir?: string
  pathEnv?: string
  candidateDirectories?: readonly string[]
  timeoutMs?: number
  runCommand?: CommandRunner
}

const EMPTY_CAPABILITIES: BinaryCapabilities = {
  hooks: false,
  agentsJson: false,
  backgroundAttach: false,
  resume: false
}

export const runCommand: CommandRunner = (executable, args, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }

        resolvePromise({ stdout, stderr })
      }
    )
  })

async function executablePath(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, fsConstants.X_OK)
    const canonical = await realpath(candidate)
    return isAbsolute(canonical) ? canonical : resolve(canonical)
  } catch {
    return undefined
  }
}

async function nvmBinDirectories(homeDir: string): Promise<string[]> {
  const versionsDirectory = join(homeDir, '.nvm', 'versions', 'node')

  try {
    const entries = await readdir(versionsDirectory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(versionsDirectory, entry.name, 'bin'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}

async function binarySearchDirectories(options: BinaryDiscoveryOptions): Promise<string[]> {
  const homeDir = options.homeDir ?? homedir()
  const pathEntries = (options.pathEnv ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => (isAbsolute(entry) ? entry : resolve(entry)))
  const nvmDirectories = await nvmBinDirectories(homeDir)

  const directories = [
    ...(options.candidateDirectories ?? []),
    ...pathEntries,
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.volta', 'bin'),
    join(homeDir, '.asdf', 'shims'),
    join(homeDir, '.bun', 'bin'),
    join(homeDir, '.npm-global', 'bin'),
    ...nvmDirectories,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin'
  ]

  return [...new Set(directories.map((directory) => resolve(directory)))]
}

async function findBinary(
  provider: BinaryProvider,
  options: BinaryDiscoveryOptions
): Promise<string | undefined> {
  const directories = await binarySearchDirectories(options)

  for (const directory of directories) {
    const found = await executablePath(join(directory, provider))
    if (found) return found
  }

  return undefined
}

function firstOutputLine(result: CommandResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return output ? output.split(/\r?\n/, 1)[0]?.trim() : undefined
}

async function inspectCodex(
  path: string,
  runner: CommandRunner,
  timeoutMs: number
): Promise<DiscoveredBinary> {
  let version: string | undefined
  let hooks = false
  let resume = false

  try {
    version = firstOutputLine(await runner(path, ['--version'], timeoutMs))
  } catch {
    // The absolute executable is still useful even if a wrapper cannot report a version.
  }

  try {
    const result = await runner(path, ['features', 'list'], timeoutMs)
    hooks = /^hooks\s+\S+\s+true\s*$/m.test(result.stdout)
  } catch {
    hooks = false
  }

  try {
    const result = await runner(path, ['resume', '--help'], timeoutMs)
    resume = /\bresume\b/i.test(`${result.stdout}\n${result.stderr}`)
  } catch {
    resume = false
  }

  return {
    provider: 'codex',
    path,
    version,
    capabilities: { ...EMPTY_CAPABILITIES, hooks, resume }
  }
}

async function inspectClaude(
  path: string,
  runner: CommandRunner,
  timeoutMs: number
): Promise<DiscoveredBinary> {
  let version: string | undefined
  let hooks = false
  let agentsJson = false
  let backgroundAttach = false
  let resume = false

  try {
    version = firstOutputLine(await runner(path, ['--version'], timeoutMs))
  } catch {
    // Keep every capability false when the executable cannot be invoked.
  }

  try {
    const result = await runner(path, ['agents', '--json'], timeoutMs)
    agentsJson = Array.isArray(JSON.parse(result.stdout))
  } catch {
    agentsJson = false
  }

  try {
    const result = await runner(path, ['attach', '--help'], timeoutMs)
    backgroundAttach = /claude\s+attach\s+<id>/i.test(`${result.stdout}\n${result.stderr}`)
  } catch {
    backgroundAttach = false
  }

  try {
    const result = await runner(path, ['--help'], timeoutMs)
    const help = `${result.stdout}\n${result.stderr}`
    // User-level hooks are configured through settings.json. Requiring the
    // documented settings flags is a non-mutating capability probe and fails
    // closed for wrappers that merely report a Claude-looking version.
    hooks = /--settings\b/.test(help) && /--setting-sources\b/.test(help)
    resume = /--resume\b/.test(help)
  } catch {
    hooks = false
    resume = false
  }

  return {
    provider: 'claude',
    path,
    version,
    capabilities: { hooks, agentsJson, backgroundAttach, resume }
  }
}

function cursorVersionSupportsHooks(version: string | undefined): boolean {
  const match = version?.match(/(?:^|\s)(\d+)\.(\d+)(?:\.|\s|$)/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor >= 7)
}

async function inspectCursor(
  path: string,
  runner: CommandRunner,
  timeoutMs: number
): Promise<DiscoveredBinary> {
  let version: string | undefined
  try {
    version = firstOutputLine(await runner(path, ['--version'], timeoutMs))
  } catch {
    // Avoid invoking `cursor agent` during discovery because Cursor may install
    // its agent CLI as a side effect. Desktop lifecycle hooks need only Cursor.
  }

  return {
    provider: 'cursor',
    path,
    version,
    capabilities: {
      ...EMPTY_CAPABILITIES,
      hooks: cursorVersionSupportsHooks(version)
    }
  }
}

async function inspectHermes(
  path: string,
  runner: CommandRunner,
  timeoutMs: number
): Promise<DiscoveredBinary> {
  let version: string | undefined
  let hooks = false
  let resume = false

  try {
    version = firstOutputLine(await runner(path, ['--version'], timeoutMs))
  } catch {
    // Keep the executable available while capability probes fail closed.
  }

  try {
    const result = await runner(path, ['hooks', '--help'], timeoutMs)
    hooks = /\bhooks\b/i.test(`${result.stdout}\n${result.stderr}`)
  } catch {
    hooks = false
  }

  try {
    const result = await runner(path, ['--help'], timeoutMs)
    resume = /--resume\b/.test(`${result.stdout}\n${result.stderr}`)
  } catch {
    resume = false
  }

  return {
    provider: 'hermes',
    path,
    version,
    capabilities: { ...EMPTY_CAPABILITIES, hooks, resume }
  }
}

export async function discoverBinary(
  provider: BinaryProvider,
  options: BinaryDiscoveryOptions = {}
): Promise<DiscoveredBinary | undefined> {
  const path = await findBinary(provider, options)
  if (!path) return undefined

  const runner = options.runCommand ?? runCommand
  const timeoutMs = options.timeoutMs ?? 2_500
  if (provider === 'codex') return inspectCodex(path, runner, timeoutMs)
  if (provider === 'claude') return inspectClaude(path, runner, timeoutMs)
  if (provider === 'cursor') return inspectCursor(path, runner, timeoutMs)
  return inspectHermes(path, runner, timeoutMs)
}

export async function discoverBinaries(
  options: BinaryDiscoveryOptions = {}
): Promise<Partial<Record<Provider, DiscoveredBinary>>> {
  const [codex, claude, cursor, hermes] = await Promise.all([
    discoverBinary('codex', options),
    discoverBinary('claude', options),
    discoverBinary('cursor', options),
    discoverBinary('hermes', options)
  ])

  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claude } : {}),
    ...(cursor ? { cursor } : {}),
    ...(hermes ? { hermes } : {})
  }
}
