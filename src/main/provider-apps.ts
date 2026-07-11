import { spawn } from 'node:child_process'
import type { ActionResult, Provider } from '@shared'

const APPLICATION_NAME: Record<Provider, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor'
}

/** Opens only the local provider app selected by a validated renderer action. */
export function openProviderApp(provider: Provider): Promise<ActionResult> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, message: 'Provider desktop apps are available on macOS only.' })
  }

  const application = APPLICATION_NAME[provider]
  return new Promise((resolve) => {
    let opener: ReturnType<typeof spawn>
    try {
      opener = spawn('/usr/bin/open', ['-a', application], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      resolve({ ok: false, message: `Could not open ${application}.` })
      return
    }

    opener.once('error', () => resolve({ ok: false, message: `Could not open ${application}.` }))
    opener.once('close', (code) => {
      resolve(
        code === 0
          ? { ok: true, message: `${application} opened.` }
          : { ok: false, message: `Could not find ${application}.` }
      )
    })
    opener.unref()
  })
}
