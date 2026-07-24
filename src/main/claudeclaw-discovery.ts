import { access, readFile, readdir, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { Provider } from '../shared/contracts'

const MARKER_DIRECTORY = join('.claude', 'claudeclaw')
const MAX_STATE_BYTES = 128 * 1024

export interface ClaudeClawWorkspace {
  root: string
  running: boolean
  webUrl?: string
}

export interface ClaudeClawDiscoveryOptions {
  homeDir?: string
  launchAgentsDir?: string
  projectsDir?: string
  processAlive?: (pid: number) => boolean
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function workingDirectoryFromPlist(source: string): string | undefined {
  const match = source.match(
    /<key>\s*WorkingDirectory\s*<\/key>\s*<string>([^<]+)<\/string>/i
  )
  const value = match?.[1] ? decodeXml(match[1]).trim() : ''
  return value && isAbsolute(value) ? resolve(value) : undefined
}

function decodedClaudeProjectPath(name: string): string | undefined {
  if (!name.startsWith('-') || name.length < 2) return undefined
  const decoded = `/${name.slice(1).replaceAll('-', '/')}`
  return isAbsolute(decoded) ? resolve(decoded) : undefined
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function hasMarker(root: string): Promise<boolean> {
  try {
    await access(join(root, MARKER_DIRECTORY), fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function readWebUrl(root: string): Promise<string | undefined> {
  const statePath = join(root, MARKER_DIRECTORY, 'state.json')
  try {
    const metadata = await stat(statePath)
    if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) return undefined
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const web = (parsed as Record<string, unknown>).web
    if (!web || typeof web !== 'object' || Array.isArray(web)) return undefined
    const input = web as Record<string, unknown>
    if (input.enabled !== true) return undefined
    if (input.host !== '127.0.0.1' && input.host !== 'localhost') {
      return undefined
    }
    if (!Number.isSafeInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) {
      return undefined
    }
    return `http://127.0.0.1:${String(input.port)}`
  } catch {
    return undefined
  }
}

async function readRunning(
  root: string,
  processAlive: (pid: number) => boolean
): Promise<boolean> {
  try {
    const value = (await readFile(join(root, MARKER_DIRECTORY, 'daemon.pid'), 'utf8')).trim()
    if (!/^[1-9]\d{0,9}$/.test(value)) return false
    return processAlive(Number(value))
  } catch {
    return false
  }
}

export class ClaudeClawDiscovery {
  readonly homeDir: string
  readonly launchAgentsDir: string
  readonly projectsDir: string

  private readonly processAlive: (pid: number) => boolean
  private roots = new Set<string>()

  constructor(options: ClaudeClawDiscoveryOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir())
    this.launchAgentsDir = resolve(
      options.launchAgentsDir ?? join(this.homeDir, 'Library', 'LaunchAgents')
    )
    this.projectsDir = resolve(options.projectsDir ?? join(this.homeDir, '.claude', 'projects'))
    this.processAlive = options.processAlive ?? defaultProcessAlive
  }

  async refresh(): Promise<ClaudeClawWorkspace[]> {
    const candidates = new Set<string>()
    for (const root of this.roots) candidates.add(root)

    try {
      const entries = await readdir(this.launchAgentsDir, { withFileTypes: true })
      await Promise.all(entries
        .filter((entry) => entry.isFile() && /^com\.claudeclaw\..+\.plist$/i.test(entry.name))
        .map(async (entry) => {
          try {
            const root = workingDirectoryFromPlist(
              await readFile(join(this.launchAgentsDir, entry.name), 'utf8')
            )
            if (root) candidates.add(root)
          } catch {
            // An unreadable launch agent does not block other workspaces.
          }
        }))
    } catch {
      // ClaudeClaw may have no launch agents.
    }

    try {
      const entries = await readdir(this.projectsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const root = decodedClaudeProjectPath(entry.name)
        if (root) candidates.add(root)
      }
    } catch {
      // Claude may have no project index yet.
    }

    const confirmed = await Promise.all(
      [...candidates].map(async (root) => (await hasMarker(root)) ? root : undefined)
    )
    this.roots = new Set(confirmed.filter((root): root is string => Boolean(root)))
    return this.workspaces()
  }

  async resolveWorkspace(cwd: string): Promise<ClaudeClawWorkspace | undefined> {
    if (!isAbsolute(cwd) || cwd.includes('\0')) return undefined
    const candidate = resolve(cwd)
    const known = [...this.roots]
      .filter((root) => isWithin(root, candidate))
      .sort((left, right) => right.length - left.length)[0]
    if (known) return this.workspace(known)

    let current = candidate
    while (isWithin(this.homeDir, current)) {
      if (await hasMarker(current)) {
        this.roots.add(current)
        return this.workspace(current)
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  async providerForEvent(provider: Provider, payload: unknown): Promise<Provider> {
    if (provider !== 'claude' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return provider
    }
    const input = payload as Record<string, unknown>
    const cwd = [
      input.cwd,
      input.working_directory,
      input.workingDirectory,
      input.workspace_root,
      input.workspaceRoot
    ].find((value): value is string => typeof value === 'string' && value.trim() !== '')
    return cwd && await this.resolveWorkspace(cwd) ? 'claudeclaw' : provider
  }

  async workspaces(): Promise<ClaudeClawWorkspace[]> {
    return Promise.all([...this.roots].sort().map((root) => this.workspace(root)))
  }

  async preferredWorkspace(): Promise<ClaudeClawWorkspace | undefined> {
    const workspaces = await this.workspaces()
    return workspaces.find((workspace) => workspace.running) ?? workspaces[0]
  }

  private async workspace(root: string): Promise<ClaudeClawWorkspace> {
    const running = await readRunning(root, this.processAlive)
    return {
      root,
      running,
      ...(running ? { webUrl: await readWebUrl(root) } : {})
    }
  }
}
