import { z } from 'zod'
import type {
  AppSettings,
  Provider,
  ScreenPoint,
  SessionActionRequest
} from '@shared'

const activityIdSchema = z.string().min(1).max(512)
const sessionActionSchema = z.object({
  activityId: activityIdSchema,
  action: z.enum(['open_project', 'attach', 'resume', 'copy_command'])
})
const settingsPatchSchema = z
  .object({
    launchAtLogin: z.boolean().optional(),
    systemNotifications: z.boolean().optional(),
    soundNotifications: z.boolean().optional(),
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
const providerSchema = z.enum(['codex', 'claude', 'cursor'])

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
