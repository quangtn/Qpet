import { app, dialog } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AppSettings,
  AppSnapshot,
  IntegrationStatus,
  Provider,
  SessionActionRequest
} from '@shared'
import { ActivityStore } from './activity-store'
import { installApplicationMenu } from './application-menu'
import {
  discoverBinaries,
  type DiscoveredBinary
} from './binary-discovery'
import { ClaudePoller } from './claude-poller'
import { EventServer } from './event-server'
import { IntegrationManager } from './integration-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { NotificationManager, playMacNotificationSound } from './notification-manager'
import { openProviderApp } from './provider-apps'
import { performSessionAction } from './session-actions'
import { SettingsStore } from './settings-store'
import { WindowManager } from './window-manager'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000

app.setName('QPet')
const configuredUserData = process.env.QPET_USER_DATA_DIR
if (configuredUserData) app.setPath('userData', configuredUserData)

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let windowManager: WindowManager | undefined
let eventServer: EventServer | undefined
let claudePoller: ClaudePoller | undefined
let claudePollerSyncQueue: Promise<void> = Promise.resolve()
let cleanupTimer: NodeJS.Timeout | undefined
let removeIpcHandlers: (() => void) | undefined
let isShuttingDown = false

function unavailableStatus(listenerActive = false): IntegrationStatus {
  return {
    codex: {
      provider: 'codex',
      installed: false,
      health: 'unavailable',
      message: 'Codex has not been checked yet.'
    },
    claude: {
      provider: 'claude',
      installed: false,
      health: 'unavailable',
      message: 'Claude Code has not been checked yet.'
    },
    cursor: {
      provider: 'cursor',
      installed: false,
      health: 'unavailable',
      message: 'Cursor has not been checked yet.'
    },
    listenerActive
  }
}

async function bootstrap(): Promise<void> {
  const supportDir = app.getPath('userData')
  const homeDir = process.env.QPET_HOME_DIR ?? homedir()
  const settingsStore = new SettingsStore(supportDir)
  const activityStore = new ActivityStore({ supportDir })
  await Promise.all([settingsStore.initialize(), activityStore.initialize()])
  await activityStore.cleanup()

  let integrationManager: IntegrationManager | undefined
  let integrationStatus = unavailableStatus()
  let binaries: Partial<Record<Provider, DiscoveredBinary>> = {}

  const publish = (): void => {
    const snapshot = getSnapshot()
    notificationManager.handle(snapshot.activities)
    windowManager?.broadcast(snapshot)
  }

  eventServer = new EventServer({
    supportDir,
    onEvent: async (provider, payload) => {
      await activityStore.ingest(provider, payload)
      if (
        provider === 'codex' &&
        integrationStatus.codex.health === 'awaiting_trust' &&
        integrationManager
      ) {
        void integrationManager.markCodexTrusted().then((status) => {
          integrationStatus = status
          publish()
        }).catch((error) => console.warn('Could not record Codex hook trust.', error))
      }
    }
  })

  try {
    await eventServer.start()
  } catch (error) {
    console.error('QPet event listener did not start.', error)
  }

  binaries = await discoverBinaries({ homeDir })
  const helperSourcePath = app.isPackaged
    ? join(process.resourcesPath, 'qpet-hook.sh')
    : join(app.getAppPath(), 'resources', 'qpet-hook.sh')
  integrationManager = new IntegrationManager({
    homeDir,
    appSupportDir: supportDir,
    helperSourcePath,
    discover: async () => binaries,
    isListenerActive: () => eventServer?.isRunning ?? false
  })
  integrationStatus = await integrationManager.getStatus()

  const getSnapshot = (): AppSnapshot => ({
    activities: activityStore.getActivities(),
    integrations: integrationStatus,
    settings: settingsStore.get()
  })

  const notificationManager = new NotificationManager(
    () =>
      process.env.QPET_TEST_MODE !== '1' &&
      settingsStore.get().systemNotifications,
    () => windowManager?.toggleTray(),
    () => process.env.QPET_TEST_MODE !== '1' && settingsStore.get().soundNotifications
  )
  notificationManager.handle(activityStore.getActivities())

  windowManager = new WindowManager({
    preloadPath: join(MODULE_DIRECTORY, '../preload/index.cjs'),
    getSettings: () => settingsStore.get(),
    savePetPosition: async (petPosition) => {
      await settingsStore.update({ petPosition })
    },
    onTrayOpened: () => {
      void activityStore.markRead()
    }
  })
  windowManager.create()

  activityStore.subscribe(() => publish())

  const applyLoginItem = (enabled: boolean): void => {
    if (!app.isPackaged || process.env.QPET_TEST_MODE === '1') return
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
  }

  const updateSettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const settings = await settingsStore.update(patch)
    if (patch.launchAtLogin !== undefined) applyLoginItem(settings.launchAtLogin)
    if (patch.petVisible !== undefined) windowManager?.setPetVisible(settings.petVisible)
    publish()
    return settings
  }

  const refreshBinariesAndStatus = async (): Promise<IntegrationStatus> => {
    binaries = await discoverBinaries({ homeDir })
    integrationStatus = await integrationManager!.getStatus()
    await syncClaudePoller()
    publish()
    return integrationStatus
  }

  const syncClaudePoller = (): Promise<void> => {
    const operation = claudePollerSyncQueue.then(async () => {
      const claude = binaries.claude
      const shouldPoll = Boolean(
        !isShuttingDown &&
        integrationStatus.claude.installed &&
        claude?.capabilities.agentsJson &&
        process.env.QPET_DISABLE_POLLING !== '1'
      )

      if (!shouldPoll) {
        const poller = claudePoller
        claudePoller = undefined
        await poller?.stop()
        return
      }

      if (claudePoller) return
      claudePoller = new ClaudePoller({
        binaryPath: claude!.path,
        activityStore,
        onError: (error) => console.warn('Claude session reconciliation failed.', error.message)
      })
      claudePoller.start()
    })
    claudePollerSyncQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  removeIpcHandlers = registerIpcHandlers({
    getSnapshot,
    markRead: (activityId) => activityStore.markRead(activityId),
    dismiss: (activityId) => activityStore.dismiss(activityId),
    performSessionAction: async (request: SessionActionRequest) => {
      const activity = activityStore.getActivity(request.activityId)
      if (!activity) return { ok: false, message: 'That activity is no longer available.' }
      return performSessionAction(activity, request.action, { binaries })
    },
    installIntegrations: async () => {
      binaries = await discoverBinaries({ homeDir })
      const result = await integrationManager!.install()
      integrationStatus = result.status
      if (result.ok) applyLoginItem(settingsStore.get().launchAtLogin)
      await syncClaudePoller()
      publish()
      return result
    },
    uninstallIntegrations: async () => {
      const result = await integrationManager!.uninstall()
      integrationStatus = result.status
      await syncClaudePoller()
      publish()
      return result
    },
    refreshIntegrations: refreshBinariesAndStatus,
    updateSettings,
    beginPetDrag: (point) => windowManager?.beginPetDrag(point),
    movePetDrag: (point) => windowManager?.movePetDrag(point),
    endPetDrag: () => windowManager?.endPetDrag(),
    openProviderApp,
    playTestSound: () => playMacNotificationSound(),
    toggleTray: () => windowManager?.toggleTray(),
    hideTray: () => windowManager?.hideTray(),
    showSettings: () => windowManager?.showSettings(),
    quit: () => app.quit()
  })

  installApplicationMenu({
    showSettings: () => windowManager?.showSettings(),
    showPet: () => void updateSettings({ petVisible: true }),
    toggleTray: () => windowManager?.toggleTray()
  })

  await syncClaudePoller()
  if (
    integrationStatus.codex.installed ||
    integrationStatus.claude.installed ||
    integrationStatus.cursor.installed
  ) {
    applyLoginItem(settingsStore.get().launchAtLogin)
  } else if (process.env.QPET_SKIP_ONBOARDING !== '1') {
    setTimeout(() => windowManager?.showOnboarding(), 450)
  }

  cleanupTimer = setInterval(() => {
    void activityStore.cleanup()
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  app.on('second-instance', () => {
    void updateSettings({ petVisible: true })
    windowManager?.toggleTray()
  })
  app.on('activate', () => {
    void updateSettings({ petVisible: true })
  })

  app.once('before-quit', (event) => {
    if (isShuttingDown) return
    event.preventDefault()
    isShuttingDown = true
    if (cleanupTimer) clearInterval(cleanupTimer)
    removeIpcHandlers?.()
    Promise.allSettled([
      syncClaudePoller(),
      eventServer?.stop(),
      activityStore.flush()
    ]).finally(() => {
      windowManager?.destroy()
      app.quit()
    })
  })
}

if (hasSingleInstanceLock) {
  app.whenReady().then(bootstrap).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(message)
    dialog.showErrorBox('QPet could not start', message)
    app.quit()
  })
}
