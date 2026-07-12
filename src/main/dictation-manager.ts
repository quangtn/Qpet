import { clipboard, globalShortcut } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AppSettings, DictationAction, DictationStatus } from '@shared'

export const DICTATION_SHORTCUT = 'Control+Option+Space'
// Partial recognition updates contain the full text-so-far, so a bounded but
// generous total prevents long dictations from failing as those updates accrue.
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024

interface HelperResponse {
  ok?: boolean
  text?: string
  error?: string
  partial?: boolean
}

interface DictationManagerOptions {
  helperPath: string
  getSettings(): AppSettings
  onStatus(status: DictationStatus): void
  registerShortcut?: (accelerator: string, callback: () => void) => boolean
  unregisterShortcut?: (accelerator: string) => void
  copyText?: (text: string) => void
  spawnHelper?: () => ChildProcess
  playCue?: (kind: 'start' | 'copied') => void
}

export class DictationManager {
  private helper: ChildProcess | undefined
  private output = ''
  private outputBytes = 0
  private finalResponse: HelperResponse | undefined
  private resetTimer: NodeJS.Timeout | undefined
  private stopTimer: NodeJS.Timeout | undefined
  private registered = false
  private reviewText = ''
  private status: DictationStatus = {
    state: 'idle',
    shortcut: DICTATION_SHORTCUT
  }

  constructor(private readonly options: DictationManagerOptions) {}

  getStatus(): DictationStatus {
    return { ...this.status }
  }

  configure(): void {
    const enabled = this.options.getSettings().dictationEnabled
    if (!enabled) {
      this.unregister()
      this.cancel()
      return
    }
    if (this.registered) return
    const register = this.options.registerShortcut ?? ((accelerator, callback) =>
      globalShortcut.register(accelerator, callback))
    this.registered = register(DICTATION_SHORTCUT, () => this.toggle())
    if (!this.registered) {
      this.setStatus('error', 'The dictation shortcut is already in use.')
    }
  }

  toggle(): void {
    if (!this.options.getSettings().dictationEnabled) return
    if (this.status.state === 'listening') {
      this.stop()
      return
    }
    if (this.status.state === 'transcribing') return
    if (this.status.state === 'reviewing') {
      this.performAction('retry')
      return
    }
    this.start()
  }

  performAction(action: DictationAction, editedText?: string): void {
    if (action === 'retry') {
      this.reviewText = ''
      this.start()
      return
    }
    if (action === 'cancel') {
      this.cancel()
      return
    }
    const text = editedText === undefined ? this.reviewText : editedText.trim()
    if (action !== 'copy' || !text || this.status.state !== 'reviewing') return
    ;(this.options.copyText ?? ((value) => clipboard.writeText(value)))(text)
    this.reviewText = ''
    if (this.options.getSettings().dictationSounds) this.playCue('copied')
    this.setStatus('copied')
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined
      this.setStatus('idle')
    }, 1_600)
  }

  destroy(): void {
    this.unregister()
    this.cancel()
    if (this.resetTimer) clearTimeout(this.resetTimer)
    if (this.stopTimer) clearTimeout(this.stopTimer)
  }

  private start(): void {
    this.cancel()
    this.output = ''
    this.outputBytes = 0
    this.finalResponse = undefined
    const helper = this.options.spawnHelper?.() ?? spawn(this.options.helperPath, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    this.helper = helper
    helper.stdout?.setEncoding('utf8')
    helper.stdout?.on('data', (chunk: string) => {
      this.outputBytes += Buffer.byteLength(chunk)
      if (this.outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        this.helper = undefined
        helper.kill('SIGKILL')
        this.setStatus('error', 'Dictation output was too large.')
        return
      }
      this.output += chunk
      this.consumeOutput()
    })
    helper.once('error', () => {
      if (this.helper !== helper) return
      this.helper = undefined
      this.setStatus('error', 'Dictation could not start.')
    })
    helper.once('close', () => this.finish(helper))
    this.setStatus('listening')
    if (this.options.getSettings().dictationSounds) this.playCue('start')
  }

  private stop(): void {
    if (!this.helper) return
    this.setStatus('transcribing', undefined, this.status.preview)
    this.helper.stdin?.end('\n')
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      const helper = this.helper
      if (!helper) return
      this.helper = undefined
      helper.kill('SIGKILL')
      this.setStatus('error', 'Transcription timed out. Try again.')
    }, 8_000)
  }

  private finish(helper: ChildProcess): void {
    if (this.helper !== helper) return
    this.helper = undefined
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }
    this.consumeOutput(true)
    const response = this.finalResponse

    const text = response?.ok && typeof response.text === 'string'
      ? response.text.trim()
      : ''
    if (!text) {
      this.setStatus('error', response?.error || 'No speech was recognized.')
      return
    }

    this.reviewText = text
    this.setStatus('reviewing', undefined, text)
  }

  private consumeOutput(flush = false): void {
    const lines = this.output.split(/\r?\n/)
    const remainder = lines.pop() ?? ''
    this.output = flush ? '' : remainder
    if (flush && remainder.trim()) lines.push(remainder)
    for (const line of lines) {
      if (!line.trim()) continue
      let response: HelperResponse
      try {
        response = JSON.parse(line) as HelperResponse
      } catch {
        continue
      }
      const text = response.ok && typeof response.text === 'string'
        ? response.text.trim()
        : ''
      if (response.partial) {
        if (text && (this.status.state === 'listening' || this.status.state === 'transcribing')) {
          this.setStatus(this.status.state, undefined, text)
        }
      } else {
        this.finalResponse = response
      }
    }
  }

  private cancel(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = undefined
    }
    const helper = this.helper
    this.helper = undefined
    helper?.kill('SIGKILL')
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }
    this.output = ''
    this.outputBytes = 0
    this.finalResponse = undefined
    this.reviewText = ''
    if (this.status.state !== 'idle') this.setStatus('idle')
  }

  private unregister(): void {
    if (!this.registered) return
    ;(this.options.unregisterShortcut ?? ((accelerator) =>
      globalShortcut.unregister(accelerator)))(DICTATION_SHORTCUT)
    this.registered = false
  }

  private playCue(kind: 'start' | 'copied'): void {
    if (this.options.playCue) {
      this.options.playCue(kind)
      return
    }
    const sound = kind === 'start' ? 'Pop.aiff' : 'Tink.aiff'
    const player = spawn('/usr/bin/afplay', [`/System/Library/Sounds/${sound}`], {
      detached: true,
      stdio: 'ignore'
    })
    player.once('error', () => undefined)
    player.unref()
  }

  private setStatus(state: DictationStatus['state'], message?: string, preview?: string): void {
    this.status = {
      state,
      shortcut: DICTATION_SHORTCUT,
      ...(message ? { message } : {}),
      ...(preview ? { preview } : {})
    }
    this.options.onStatus(this.getStatus())
  }
}
