import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { AppSettings, DictationStatus } from '../src/shared/contracts'
import { DictationManager, DICTATION_SHORTCUT } from '../src/main/dictation-manager'

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    launchAtLogin: true,
    systemNotifications: true,
    soundNotifications: true,
    soundTriggers: ['needs_input', 'blocked', 'ready'],
    dictationEnabled: true,
    dictationSounds: true,
    petVisible: true,
    petTheme: 'classic',
    ...patch
  }
}

function fakeHelper(): ChildProcess {
  const process = new EventEmitter() as ChildProcess
  Object.assign(process, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: null,
    kill: vi.fn(() => true)
  })
  return process
}

describe('DictationManager', () => {
  it('registers only when enabled and copies only the final helper result', () => {
    vi.useFakeTimers()
    const helper = fakeHelper()
    const statuses: DictationStatus[] = []
    const copyText = vi.fn()
    const register = vi.fn((_shortcut: string, callback: () => void) => {
      callback()
      return true
    })
    const manager = new DictationManager({
      helperPath: '/helper',
      getSettings: () => settings(),
      onStatus: (status) => statuses.push(status),
      registerShortcut: register,
      unregisterShortcut: vi.fn(),
      copyText,
      spawnHelper: () => helper,
      playCue: vi.fn()
    })

    manager.configure()
    expect(register).toHaveBeenCalledWith(DICTATION_SHORTCUT, expect.any(Function))
    expect(statuses.at(-1)?.state).toBe('listening')
    helper.stdout?.emit('data', '{"ok":true,"text":"Hello from","partial":true}\n')
    expect(statuses.at(-1)).toMatchObject({
      state: 'listening',
      preview: 'Hello from'
    })
    manager.toggle()
    expect(statuses.at(-1)).toMatchObject({
      state: 'transcribing',
      preview: 'Hello from'
    })
    helper.stdout?.emit('data', '{"ok":true,"text":"Hello from QPet","partial":false}\n')
    helper.emit('close', 0)
    expect(copyText).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toMatchObject({
      state: 'reviewing',
      preview: 'Hello from QPet'
    })
    manager.performAction('copy', 'Hello from edited QPet')
    expect(copyText).toHaveBeenCalledWith('Hello from edited QPet')
    expect(statuses.at(-1)?.state).toBe('copied')
    vi.advanceTimersByTime(1_600)
    expect(statuses.at(-1)?.state).toBe('idle')
    manager.destroy()
    vi.useRealTimers()
  })

  it('does not register while Dictation Beta is disabled', () => {
    const register = vi.fn(() => true)
    const manager = new DictationManager({
      helperPath: '/helper',
      getSettings: () => settings({ dictationEnabled: false }),
      onStatus: vi.fn(),
      registerShortcut: register
    })
    manager.configure()
    expect(register).not.toHaveBeenCalled()
  })

  it('can dismiss or retry a review without copying text', () => {
    const helpers = [fakeHelper(), fakeHelper()]
    const spawned: ChildProcess[] = []
    const statuses: DictationStatus[] = []
    const copyText = vi.fn()
    const manager = new DictationManager({
      helperPath: '/helper',
      getSettings: () => settings({ dictationSounds: false }),
      onStatus: (status) => statuses.push(status),
      registerShortcut: vi.fn(() => true),
      unregisterShortcut: vi.fn(),
      copyText,
      spawnHelper: () => {
        const helper = helpers.shift()
        if (!helper) throw new Error('Missing fake dictation helper')
        spawned.push(helper)
        return helper
      }
    })

    manager.configure()
    manager.toggle()
    const activeHelper = spawned[0]
    activeHelper.stdout?.emit('data', '{"ok":true,"text":"First take","partial":false}\n')
    activeHelper.emit('close', 0)
    expect(statuses.at(-1)?.state).toBe('reviewing')

    manager.performAction('retry')
    expect(statuses.at(-1)?.state).toBe('listening')
    expect(copyText).not.toHaveBeenCalled()
    manager.performAction('cancel')
    expect(statuses.at(-1)?.state).toBe('idle')
    expect(copyText).not.toHaveBeenCalled()
    expect(spawned).toHaveLength(2)
    expect(spawned[1].kill).toHaveBeenCalledWith('SIGKILL')
    manager.destroy()
  })

  it('leaves transcribing with an error if the helper never finalizes', () => {
    vi.useFakeTimers()
    const helper = fakeHelper()
    const statuses: DictationStatus[] = []
    const manager = new DictationManager({
      helperPath: '/helper',
      getSettings: () => settings({ dictationSounds: false }),
      onStatus: (status) => statuses.push(status),
      registerShortcut: vi.fn(() => true),
      unregisterShortcut: vi.fn(),
      spawnHelper: () => helper
    })
    manager.configure()
    manager.toggle()
    manager.toggle()
    expect(statuses.at(-1)?.state).toBe('transcribing')
    vi.advanceTimersByTime(8_000)
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'Transcription timed out. Try again.'
    })
    expect(helper.kill).toHaveBeenCalledWith('SIGKILL')
    manager.destroy()
    vi.useRealTimers()
  })

  it('does not let the copied-state timer hide a newly started session', () => {
    vi.useFakeTimers()
    const helpers = [fakeHelper(), fakeHelper()]
    const spawned: ChildProcess[] = []
    const statuses: DictationStatus[] = []
    const manager = new DictationManager({
      helperPath: '/helper',
      getSettings: () => settings({ dictationSounds: false }),
      onStatus: (status) => statuses.push(status),
      registerShortcut: vi.fn(() => true),
      unregisterShortcut: vi.fn(),
      copyText: vi.fn(),
      spawnHelper: () => {
        const helper = helpers.shift()
        if (!helper) throw new Error('Missing fake dictation helper')
        spawned.push(helper)
        return helper
      }
    })

    manager.configure()
    manager.toggle()
    const activeHelper = spawned[0]
    activeHelper.stdout?.emit('data', '{"ok":true,"text":"First take","partial":false}\n')
    activeHelper.emit('close', 0)
    manager.performAction('copy')
    manager.toggle()

    vi.advanceTimersByTime(1_600)
    expect(statuses.at(-1)?.state).toBe('listening')
    expect(spawned).toHaveLength(2)
    expect(spawned[1].kill).not.toHaveBeenCalled()

    manager.destroy()
    vi.useRealTimers()
  })
})
