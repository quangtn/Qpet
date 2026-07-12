import { ipcMain } from 'electron'
import type {
  ActionResult,
  AppSettings,
  AppSnapshot,
  DictationAction,
  InstallResult,
  IntegrationStatus,
  Provider,
  ScreenPoint,
  SessionActionRequest,
  SoundTrigger
} from '@shared'
import { IPC } from '@shared'
import {
  parseActivityId,
  parseDictationAction,
  parseDictationText,
  parseProvider,
  parseScreenPoint,
  parseSessionAction,
  parseSoundTrigger,
  parseSettingsPatch
} from './ipc-schemas'

export {
  parseActivityId,
  parseDictationAction,
  parseDictationText,
  parseProvider,
  parseScreenPoint,
  parseSessionAction,
  parseSoundTrigger,
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
  playTestSound(trigger: SoundTrigger): void
  toggleDictation(): void
  performDictationAction(action: DictationAction, text?: string): void
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
    [IPC.soundPlayTest, (_event, rawTrigger) =>
      dependencies.playTestSound(parseSoundTrigger(rawTrigger))],
    [IPC.dictationToggle, () => dependencies.toggleDictation()],
    [IPC.dictationAction, (_event, rawAction, rawText) => {
      const action = parseDictationAction(rawAction)
      const text = action === 'copy' ? parseDictationText(rawText) : undefined
      return dependencies.performDictationAction(action, text)
    }],
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
