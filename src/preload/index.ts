import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionResult,
  AppSettings,
  AppSnapshot,
  InstallResult,
  IntegrationStatus,
  QPetApi,
  ScreenPoint,
  SessionActionRequest
} from '@shared'
import { IPC } from '@shared'

const api: QPetApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet) as Promise<AppSnapshot>,
  markRead: (activityId?: string) =>
    ipcRenderer.invoke(IPC.activityMarkRead, activityId) as Promise<void>,
  dismiss: (activityId: string) =>
    ipcRenderer.invoke(IPC.activityDismiss, activityId) as Promise<void>,
  performSessionAction: (request: SessionActionRequest) =>
    ipcRenderer.invoke(IPC.sessionAction, request),
  installIntegrations: () =>
    ipcRenderer.invoke(IPC.integrationsInstall) as Promise<InstallResult>,
  uninstallIntegrations: () =>
    ipcRenderer.invoke(IPC.integrationsUninstall) as Promise<InstallResult>,
  refreshIntegrations: () =>
    ipcRenderer.invoke(IPC.integrationsRefresh) as Promise<IntegrationStatus>,
  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
  beginPetDrag: (point: ScreenPoint) =>
    ipcRenderer.invoke(IPC.petDragBegin, point) as Promise<void>,
  movePetDrag: (point: ScreenPoint) =>
    ipcRenderer.invoke(IPC.petDragMove, point) as Promise<void>,
  endPetDrag: () => ipcRenderer.invoke(IPC.petDragEnd) as Promise<void>,
  openProviderApp: (provider) =>
    ipcRenderer.invoke(IPC.providerAppOpen, provider) as Promise<ActionResult>,
  playTestSound: () => ipcRenderer.invoke(IPC.soundPlayTest) as Promise<void>,
  toggleTray: () => ipcRenderer.invoke(IPC.trayToggle) as Promise<void>,
  hideTray: () => ipcRenderer.invoke(IPC.trayHide) as Promise<void>,
  showSettings: () => ipcRenderer.invoke(IPC.settingsShow) as Promise<void>,
  quit: () => ipcRenderer.invoke(IPC.appQuit) as Promise<void>,
  onSnapshot: (callback: (snapshot: AppSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.snapshotChanged, listener)
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, listener)
  }
}

contextBridge.exposeInMainWorld('qpet', api)
