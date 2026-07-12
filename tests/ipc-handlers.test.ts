import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import {
  parseActivityId,
  parseDictationAction,
  parseDictationText,
  parseProvider,
  parseScreenPoint,
  parseSessionAction,
  parseSoundTrigger,
  parseSettingsPatch
} from '../src/main/ipc-schemas'

describe('IPC input schemas', () => {
  it('accepts valid activity ids and rejects empty values', () => {
    expect(parseActivityId('codex:abc')).toBe('codex:abc')
    expect(() => parseActivityId('')).toThrow(ZodError)
  })

  it('parses session actions and rejects unknown actions', () => {
    expect(
      parseSessionAction({ activityId: 'claude:1', action: 'open_project' })
    ).toEqual({ activityId: 'claude:1', action: 'open_project' })
    expect(() =>
      parseSessionAction({ activityId: 'claude:1', action: 'delete_all' })
    ).toThrow(ZodError)
  })

  it('parses strict settings patches', () => {
    expect(parseSettingsPatch({ petTheme: 'qmini', petVisible: false })).toEqual({
      petTheme: 'qmini',
      petVisible: false
    })
    expect(() => parseSettingsPatch({ petTheme: 'neon' })).toThrow(ZodError)
    expect(() => parseSettingsPatch({ unknown: true })).toThrow(ZodError)
    expect(parseSettingsPatch({ soundTriggers: ['blocked', 'ready'] })).toEqual({
      soundTriggers: ['blocked', 'ready']
    })
    expect(() => parseSettingsPatch({ soundTriggers: ['working'] })).toThrow(ZodError)
  })

  it('parses screen points within bounds', () => {
    expect(parseScreenPoint({ x: 12.5, y: -4 })).toEqual({ x: 12.5, y: -4 })
    expect(() => parseScreenPoint({ x: Number.NaN, y: 0 })).toThrow(ZodError)
    expect(() => parseScreenPoint({ x: 1 })).toThrow(ZodError)
  })

  it('parses providers', () => {
    expect(parseProvider('cursor')).toBe('cursor')
    expect(() => parseProvider('windsurf')).toThrow(ZodError)
  })

  it('parses only supported test-sound triggers', () => {
    expect(parseSoundTrigger('ready')).toBe('ready')
    expect(() => parseSoundTrigger('running')).toThrow(ZodError)
  })

  it('validates narrow dictation actions and edited text', () => {
    expect(parseDictationAction('copy')).toBe('copy')
    expect(parseDictationText('Edited transcription')).toBe('Edited transcription')
    expect(() => parseDictationAction('paste')).toThrow(ZodError)
    expect(() => parseDictationText('x'.repeat(64 * 1024 + 1))).toThrow(ZodError)
  })
})
