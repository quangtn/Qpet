import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  ActionResult,
  AppSettings,
  AppSnapshot,
  InstallResult,
  IntegrationStatus,
  Provider,
  ScreenPoint,
  SessionActionRequest
} from '@shared'
import { IPC } from '@shared'

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
    petVisible: z.boolean().optional()
  })
  .strict()
const screenPointSchema = z
  .object({
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000)
  })
  .strict()
const providerSchema = z.enum(['codex', 'claude', 'cursor'])

export interface IpcHandlerDependencies {
  getSnapshot(): Promise<AppSnapshot> | AppSnapshot
  markRead(activityId?: string): Promise<void> | void
  dismiss(activityId: string): Promise<void> | void
  performSessionAction(request: SessionActionRequest): Promise<ActionResult>
  installIntegrations(): Promise<InstallResult>
  uninstallIntegrations(): Promise<InstallResult>
  refreshIntegrations(): Promise<IntegrationStatus>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  beginPetDrag(point: ScreenPoint): void
  movePetDrag(point: ScreenPoint): void
  endPetDrag(): void
  openProviderApp(provider: Provider): Promise<ActionResult>
  playTestSound(): void
  toggleTray(): void
  hideTray(): void
  showSettings(): void
  quit(): void
}

export function registerIpcHandlers(dependencies: IpcHandlerDependencies): () => void {
  const handlers: Array<[string, (...args: unknown[]) => unknown]> = [
    [IPC.snapshotGet, () => dependencies.getSnapshot()],
    [IPC.activityMarkRead, (_event, rawId) => {
      const id = rawId === undefined ? undefined : activityIdSchema.parse(rawId)
      return dependencies.markRead(id)
    }],
    [IPC.activityDismiss, (_event, rawId) =>
      dependencies.dismiss(activityIdSchema.parse(rawId))],
    [IPC.sessionAction, (_event, rawRequest) =>
      dependencies.performSessionAction(sessionActionSchema.parse(rawRequest))],
    [IPC.integrationsInstall, () => dependencies.installIntegrations()],
    [IPC.integrationsUninstall, () => dependencies.uninstallIntegrations()],
    [IPC.integrationsRefresh, () => dependencies.refreshIntegrations()],
    [IPC.settingsUpdate, (_event, rawPatch) =>
      dependencies.updateSettings(settingsPatchSchema.parse(rawPatch))],
    [IPC.petDragBegin, (_event, rawPoint) =>
      dependencies.beginPetDrag(screenPointSchema.parse(rawPoint))],
    [IPC.petDragMove, (_event, rawPoint) =>
      dependencies.movePetDrag(screenPointSchema.parse(rawPoint))],
    [IPC.petDragEnd, () => dependencies.endPetDrag()],
    [IPC.providerAppOpen, (_event, rawProvider) =>
      dependencies.openProviderApp(providerSchema.parse(rawProvider))],
    [IPC.soundPlayTest, () => dependencies.playTestSound()],
    [IPC.trayToggle, () => dependencies.toggleTray()],
    [IPC.trayHide, () => dependencies.hideTray()],
    [IPC.settingsShow, () => dependencies.showSettings()],
    [IPC.appQuit, () => dependencies.quit()]
  ]

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler)
  }

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
