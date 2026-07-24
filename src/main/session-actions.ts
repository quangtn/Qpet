import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

import type {
  ActionResult,
  Activity,
  Provider,
  SessionAction
} from '../shared/contracts'
import { shellQuote } from '../shared/shell'
import type { DiscoveredBinary } from './binary-discovery'
import type { ClaudeClawWorkspace } from './claudeclaw-discovery'

export type BinaryReference = string | DiscoveredBinary

export interface SessionActionDependencies {
  binaries: Partial<Record<Provider, BinaryReference>>
  openPath?: (path: string) => Promise<string | void>
  openExternal?: (url: string) => Promise<void>
  copyText?: (text: string) => void | Promise<void>
  runAppleScript?: (script: string, args: readonly string[]) => Promise<void>
  resolveClaudeClaw?: (cwd: string) => Promise<ClaudeClawWorkspace | undefined>
}

export const TERMINAL_APPLESCRIPT = `on run argv
  if (count of argv) is not 2 then error "QPet expected a directory and command"
  set workingDirectory to item 1 of argv
  set commandText to item 2 of argv
  tell application "Terminal"
    activate
    do script "cd " & quoted form of workingDirectory & " && " & commandText
  end tell
end run`

function validValue(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && !value.includes('\0')
}

function safeClaudeClawDashboard(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const port = Number(url.port)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535
    ) return undefined
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export { shellQuote }

function binaryPath(reference: BinaryReference | undefined): string | undefined {
  const path = typeof reference === 'string' ? reference : reference?.path
  return path && isAbsolute(path) && validValue(path) ? path : undefined
}

function supports(
  reference: BinaryReference | undefined,
  capability: keyof DiscoveredBinary['capabilities']
): boolean {
  return typeof reference === 'string' || reference?.capabilities[capability] === true
}

export function buildSessionCommand(
  activity: Activity,
  action: Extract<SessionAction, 'attach' | 'resume'>,
  binaries: Partial<Record<Provider, BinaryReference>>
): string {
  if (activity.provider === 'claudeclaw') {
    throw new Error('ClaudeClaw sessions are managed by the daemon and cannot be resumed directly')
  }
  const reference = binaries[activity.provider]
  const executable = binaryPath(reference)
  if (!executable) throw new Error(`${activity.provider} executable is unavailable`)

  if (action === 'attach') {
    if (activity.provider !== 'claude' || !activity.backgroundJobId) {
      throw new Error('Only Claude background jobs can be attached')
    }
    if (!supports(reference, 'backgroundAttach')) {
      throw new Error('This Claude version does not support background attachment')
    }
    if (!validValue(activity.backgroundJobId)) throw new Error('Invalid background job identifier')
    return `${shellQuote(executable)} attach ${shellQuote(activity.backgroundJobId)}`
  }

  if (activity.live) throw new Error('A live session cannot be resumed')
  if (!supports(reference, 'resume')) {
    throw new Error(`This ${activity.provider} version does not support session resume`)
  }
  if (!validValue(activity.sessionId)) throw new Error('Invalid session identifier')

  if (activity.provider === 'claude') {
    return `${shellQuote(executable)} --resume ${shellQuote(activity.sessionId)}`
  }
  if (activity.provider === 'hermes') {
    return `${shellQuote(executable)} --resume ${shellQuote(activity.sessionId)}`
  }
  if (activity.provider === 'cursor') {
    return `${shellQuote(executable)} agent --resume ${shellQuote(activity.sessionId)}`
  }
  return `${shellQuote(executable)} resume ${shellQuote(activity.sessionId)}`
}

export function buildCopyableCommand(
  activity: Activity,
  binaries: Partial<Record<Provider, BinaryReference>>
): string {
  if (!isAbsolute(activity.cwd) || !validValue(activity.cwd)) {
    throw new Error('Project directory is invalid')
  }

  const prefix = `cd ${shellQuote(activity.cwd)}`
  if (activity.provider === 'claudeclaw') return prefix
  if (activity.provider === 'claude' && activity.backgroundJobId) {
    return `${prefix} && ${buildSessionCommand(activity, 'attach', binaries)}`
  }
  if (activity.provider === 'cursor') return prefix
  if (!activity.live) {
    return `${prefix} && ${buildSessionCommand(activity, 'resume', binaries)}`
  }

  // External live sessions cannot safely be resumed. A directory-only command
  // is still useful after QPet opens the project without taking over the session.
  return prefix
}

export function appleScriptArguments(
  script: string,
  args: readonly string[]
): string[] {
  return ['-e', script, '--', ...args]
}

function defaultRunAppleScript(script: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      appleScriptArguments(script, args),
      { timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

async function defaultOpenPath(path: string): Promise<string> {
  const { shell } = await import('electron')
  return shell.openPath(path)
}

async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

async function defaultCopyText(text: string): Promise<void> {
  const { clipboard } = await import('electron')
  clipboard.writeText(text)
}

export async function performSessionAction(
  activity: Activity,
  action: SessionAction,
  dependencies: SessionActionDependencies
): Promise<ActionResult> {
  try {
    if (!isAbsolute(activity.cwd) || !validValue(activity.cwd)) {
      throw new Error('Project directory is invalid')
    }

    if (action === 'open_project') {
      const error = await (dependencies.openPath ?? defaultOpenPath)(activity.cwd)
      if (typeof error === 'string' && error) throw new Error(error)
      return { ok: true, message: 'Project opened.' }
    }

    if (action === 'open_provider') {
      if (activity.provider !== 'claudeclaw' || !dependencies.resolveClaudeClaw) {
        throw new Error('This provider does not expose a dedicated activity view')
      }
      const workspace = await dependencies.resolveClaudeClaw(activity.cwd)
      if (!workspace) throw new Error('ClaudeClaw workspace is no longer available')
      const dashboard = safeClaudeClawDashboard(workspace.webUrl)
      if (dashboard) {
        await (dependencies.openExternal ?? defaultOpenExternal)(dashboard)
        return { ok: true, message: 'ClaudeClaw dashboard opened.' }
      }
      const error = await (dependencies.openPath ?? defaultOpenPath)(workspace.root)
      if (typeof error === 'string' && error) throw new Error(error)
      return {
        ok: true,
        message: 'ClaudeClaw dashboard is unavailable; the workspace was opened instead.'
      }
    }

    if (action === 'copy_command') {
      const command = buildCopyableCommand(activity, dependencies.binaries)
      await (dependencies.copyText ?? defaultCopyText)(command)
      return {
        ok: true,
        message: activity.live && !activity.backgroundJobId
          ? 'Project directory command copied; QPet will not resume a live session.'
          : 'Session command copied.'
      }
    }

    const command = buildSessionCommand(activity, action, dependencies.binaries)
    await (dependencies.runAppleScript ?? defaultRunAppleScript)(TERMINAL_APPLESCRIPT, [
      activity.cwd,
      command
    ])
    return {
      ok: true,
      message: action === 'attach' ? 'Claude job opened in Terminal.' : 'Session opened in Terminal.'
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
