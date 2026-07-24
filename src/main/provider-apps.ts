import { spawn } from 'node:child_process'
import type { ActionResult, Provider } from '@shared'
import type { ClaudeClawWorkspace } from './claudeclaw-discovery'

const APPLICATION_NAME: Partial<Record<Provider, string>> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor',
  hermes: 'Hermes'
}

export interface ProviderAppDependencies {
  preferredClaudeClaw?: () => Promise<ClaudeClawWorkspace | undefined>
  openExternal?: (url: string) => Promise<void>
  openPath?: (path: string) => Promise<string | void>
}

async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}

async function defaultOpenPath(path: string): Promise<string> {
  const { shell } = await import('electron')
  return shell.openPath(path)
}

function safeLoopbackUrl(value: string | undefined): string | undefined {
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

/** Opens only the local provider app selected by a validated renderer action. */
export async function openProviderApp(
  provider: Provider,
  dependencies: ProviderAppDependencies = {}
): Promise<ActionResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Provider desktop apps are available on macOS only.' }
  }

  if (provider === 'claudeclaw') {
    const workspace = await dependencies.preferredClaudeClaw?.()
    if (!workspace) return { ok: false, message: 'No ClaudeClaw workspace was found.' }
    const dashboard = safeLoopbackUrl(workspace.webUrl)
    if (dashboard) {
      await (dependencies.openExternal ?? defaultOpenExternal)(dashboard)
      return { ok: true, message: 'ClaudeClaw dashboard opened.' }
    }
    const error = await (dependencies.openPath ?? defaultOpenPath)(workspace.root)
    return typeof error === 'string' && error
      ? { ok: false, message: error }
      : {
          ok: true,
          message: 'ClaudeClaw dashboard is unavailable; the workspace was opened instead.'
        }
  }

  const application = APPLICATION_NAME[provider]
  if (!application) return { ok: false, message: 'This provider has no desktop app target.' }
  return new Promise((resolvePromise) => {
    let opener: ReturnType<typeof spawn>
    try {
      opener = spawn('/usr/bin/open', ['-a', application], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      resolvePromise({ ok: false, message: `Could not open ${application}.` })
      return
    }

    opener.once('error', () =>
      resolvePromise({ ok: false, message: `Could not open ${application}.` })
    )
    opener.once('close', (code) => {
      resolvePromise(
        code === 0
          ? { ok: true, message: `${application} opened.` }
          : { ok: false, message: `Could not find ${application}.` }
      )
    })
    opener.unref()
  })
}
