import { z } from 'zod'
import type {
  AppSettings,
  DictationAction,
  Provider,
  ScreenPoint,
  SessionActionRequest,
  SoundTrigger
} from '@shared'

const activityIdSchema = z.string().min(1).max(512)
const sessionActionSchema = z.object({
  activityId: activityIdSchema,
  action: z.enum(['open_project', 'open_provider', 'attach', 'resume', 'copy_command'])
})
const settingsPatchSchema = z
  .object({
    launchAtLogin: z.boolean().optional(),
    systemNotifications: z.boolean().optional(),
    soundNotifications: z.boolean().optional(),
    soundTriggers: z.array(z.enum(['needs_input', 'blocked', 'ready'])).max(3).optional(),
    dictationEnabled: z.boolean().optional(),
    dictationSounds: z.boolean().optional(),
    petVisible: z.boolean().optional(),
    petTheme: z.enum(['classic', 'qmini']).optional()
  })
  .strict()
const screenPointSchema = z
  .object({
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000)
  })
  .strict()
const providerSchema = z.enum(['codex', 'claude', 'cursor', 'hermes', 'claudeclaw'])
const soundTriggerSchema = z.enum(['needs_input', 'blocked', 'ready'])
const dictationActionSchema = z.enum(['copy', 'retry', 'cancel'])
const dictationTextSchema = z.string().max(64 * 1024)

export function parseActivityId(raw: unknown): string {
  return activityIdSchema.parse(raw)
}

export function parseSessionAction(raw: unknown): SessionActionRequest {
  return sessionActionSchema.parse(raw)
}

export function parseSettingsPatch(raw: unknown): Partial<AppSettings> {
  return settingsPatchSchema.parse(raw)
}

export function parseScreenPoint(raw: unknown): ScreenPoint {
  return screenPointSchema.parse(raw)
}

export function parseProvider(raw: unknown): Provider {
  return providerSchema.parse(raw)
}

export function parseSoundTrigger(raw: unknown): SoundTrigger {
  return soundTriggerSchema.parse(raw)
}

export function parseDictationAction(raw: unknown): DictationAction {
  return dictationActionSchema.parse(raw)
}

export function parseDictationText(raw: unknown): string {
  return dictationTextSchema.parse(raw)
}
