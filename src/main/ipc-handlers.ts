import { ipcMain } from 'electron'
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
import {
  parseActivityId,
  parseProvider,
  parseScreenPoint,
  parseSessionAction,
  parseSettingsPatch
} from './ipc-schemas'

export {
  parseActivityId,
  parseProvider,
  parseScreenPoint,
  parseSessionAction,
  parseSettingsPatch
} from './ipc-schemas'

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
      const id = rawId === undefined ? undefined : parseActivityId(rawId)
      return dependencies.markRead(id)
    }],
    [IPC.activityDismiss, (_event, rawId) =>
      dependencies.dismiss(parseActivityId(rawId))],
    [IPC.sessionAction, (_event, rawRequest) =>
      dependencies.performSessionAction(parseSessionAction(rawRequest))],
    [IPC.integrationsInstall, () => dependencies.installIntegrations()],
    [IPC.integrationsUninstall, () => dependencies.uninstallIntegrations()],
    [IPC.integrationsRefresh, () => dependencies.refreshIntegrations()],
    [IPC.settingsUpdate, (_event, rawPatch) =>
      dependencies.updateSettings(parseSettingsPatch(rawPatch))],
    [IPC.petDragBegin, (_event, rawPoint) =>
      dependencies.beginPetDrag(parseScreenPoint(rawPoint))],
    [IPC.petDragMove, (_event, rawPoint) =>
      dependencies.movePetDrag(parseScreenPoint(rawPoint))],
    [IPC.petDragEnd, () => dependencies.endPetDrag()],
    [IPC.providerAppOpen, (_event, rawProvider) =>
      dependencies.openProviderApp(parseProvider(rawProvider))],
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
