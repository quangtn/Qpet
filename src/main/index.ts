import { app, dialog } from 'electron'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AppSettings,
  AppSnapshot,
  DictationStatus,
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
import { ClaudeClawDiscovery } from './claudeclaw-discovery'
import { EventServer } from './event-server'
import { DictationManager } from './dictation-manager'
import { IntegrationManager } from './integration-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { NotificationManager, playMacNotificationSound } from './notification-manager'
import { openProviderApp } from './provider-apps'
import { RecoveryTray } from './recovery-tray'
import { performSessionAction } from './session-actions'
import { SettingsStore } from './settings-store'
import { WindowManager } from './window-manager'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const CLEANUP_INTERVAL_MS = 60 * 1_000

app.setName('QPet')
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
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
let recoveryTray: RecoveryTray | undefined
let dictationManager: DictationManager | undefined
let isShuttingDown = false

function unavailableStatus(listenerActive = false, listenerMessage?: string): IntegrationStatus {
  return {
    codex: {
      provider: 'codex',
      installed: false,
      health: 'unavailable',
      message: 'ChatGPT has not been checked yet.'
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
    hermes: {
      provider: 'hermes',
      installed: false,
      health: 'unavailable',
      message: 'Hermes has not been checked yet.'
    },
    claudeclaw: {
      provider: 'claudeclaw',
      installed: false,
      health: 'unavailable',
      message: 'ClaudeClaw has not been checked yet.'
    },
    listenerActive,
    ...(listenerActive || !listenerMessage ? {} : { listenerMessage })
  }
}

async function bootstrap(): Promise<void> {
  const supportDir = app.getPath('userData')
  const homeDir = process.env.QPET_HOME_DIR ?? homedir()
  const settingsStore = new SettingsStore(supportDir)
  const activityStore = new ActivityStore({
    supportDir,
    onDiagnostic: (diagnostic) => {
      console.warn('QPet suppressed a cross-provider activity collision.', diagnostic)
    }
  })
  await Promise.all([settingsStore.initialize(), activityStore.initialize()])
  const claudeClawDiscovery = new ClaudeClawDiscovery({ homeDir })
  const initialClaudeClawWorkspaces = await claudeClawDiscovery.refresh()
  await activityStore.reclassifyClaudeActivities(
    initialClaudeClawWorkspaces.map((workspace) => workspace.root)
  )
  await activityStore.cleanup()

  let integrationManager: IntegrationManager | undefined
  let integrationStatus = unavailableStatus()
  let dictationStatus: DictationStatus = {
    state: 'idle',
    shortcut: 'Control+Option+Space'
  }
  let binaries: Partial<Record<Provider, DiscoveredBinary>> = {}
  let listenerError: string | undefined

  const publish = (): void => {
    const snapshot = getSnapshot()
    notificationManager.handle(snapshot.activities)
    windowManager?.broadcast(snapshot)
  }

  eventServer = new EventServer({
    supportDir,
    onEvent: async (provider, payload) => {
      const classifiedProvider = await claudeClawDiscovery.providerForEvent(provider, payload)
      await activityStore.ingest(classifiedProvider, payload)
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
    listenerError = undefined
  } catch (error) {
    listenerError = error instanceof Error ? error.message : String(error)
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
    isListenerActive: () => eventServer?.isRunning ?? false,
    listenerMessage: () =>
      listenerError
        ? `QPet’s local event listener failed to start: ${listenerError}`
        : undefined,
    claudeClawWorkspaces: () => claudeClawDiscovery.workspaces()
  })
  integrationStatus = await integrationManager.getStatus()

  const getSnapshot = (): AppSnapshot => ({
    activities: activityStore.getActivities(),
    integrations: integrationStatus,
    settings: settingsStore.get(),
    dictation: dictationStatus,
    appVersion: app.getVersion()
  })

  const notificationManager = new NotificationManager(
    () =>
      process.env.QPET_TEST_MODE !== '1' &&
      settingsStore.get().systemNotifications,
    () => windowManager?.toggleTray(),
    () => {
      const settings = settingsStore.get()
      return process.env.QPET_TEST_MODE !== '1' && settings.soundNotifications
        ? settings.soundTriggers
        : []
    }
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

  const dictationHelperPath = app.isPackaged
    ? join(process.resourcesPath, 'qpet-dictation-helper')
    : join(app.getAppPath(), '.build', 'qpet-dictation-helper')
  dictationManager = new DictationManager({
    helperPath: dictationHelperPath,
    getSettings: () => settingsStore.get(),
    onStatus: (status) => {
      dictationStatus = status
      publish()
      windowManager?.setDictationPreviewVisible(
        status.state === 'listening' ||
          status.state === 'transcribing' ||
          status.state === 'reviewing' ||
          status.state === 'error',
        status.state === 'reviewing' || status.state === 'error'
      )
    }
  })
  if (process.env.QPET_TEST_MODE !== '1') dictationManager.configure()

  activityStore.subscribe(() => publish())

  const applyLoginItem = (enabled: boolean): void => {
    if (!app.isPackaged || process.env.QPET_TEST_MODE === '1') return
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
  }

  let syncRecoveryTray = (_petVisible: boolean): void => undefined

  const updateSettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const settings = await settingsStore.update(patch)
    if (patch.launchAtLogin !== undefined) applyLoginItem(settings.launchAtLogin)
    if (patch.petVisible !== undefined) {
      windowManager?.setPetVisible(settings.petVisible)
      syncRecoveryTray(settings.petVisible)
    }
    if (
      process.env.QPET_TEST_MODE !== '1' &&
      (patch.dictationEnabled !== undefined || patch.dictationSounds !== undefined)
    ) {
      dictationManager?.configure()
    }
    publish()
    return settings
  }

  if (process.platform === 'darwin') {
    recoveryTray = new RecoveryTray(
      join(MODULE_DIRECTORY, '../renderer/pets/qmini/app-icon.png'),
      {
        showPet: () => void updateSettings({ petVisible: true }),
        showActivity: () => windowManager?.toggleTray(),
        showSettings: () => windowManager?.showSettings()
      }
    )
    syncRecoveryTray = (petVisible) => recoveryTray?.setPetVisible(petVisible)
    syncRecoveryTray(settingsStore.get().petVisible)
  }

  const refreshBinariesAndStatus = async (): Promise<IntegrationStatus> => {
    const [discoveredBinaries, workspaces] = await Promise.all([
      discoverBinaries({ homeDir }),
      claudeClawDiscovery.refresh()
    ])
    binaries = discoveredBinaries
    await activityStore.reclassifyClaudeActivities(
      workspaces.map((workspace) => workspace.root)
    )
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
        classifyObservation: async (observation) => {
          const workspace = await claudeClawDiscovery.resolveWorkspace(observation.cwd)
          return workspace
            ? {
                ...observation,
                provider: 'claudeclaw',
                summary: observation.summary?.replace(/^Claude\b/, 'ClaudeClaw')
              }
            : observation
        },
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
      return performSessionAction(activity, request.action, {
        binaries,
        resolveClaudeClaw: (cwd) => claudeClawDiscovery.resolveWorkspace(cwd)
      })
    },
    installIntegrations: async () => {
      const [discoveredBinaries, workspaces] = await Promise.all([
        discoverBinaries({ homeDir }),
        claudeClawDiscovery.refresh()
      ])
      binaries = discoveredBinaries
      await activityStore.reclassifyClaudeActivities(
        workspaces.map((workspace) => workspace.root)
      )
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
    openProviderApp: (provider) => openProviderApp(provider, {
      preferredClaudeClaw: () => claudeClawDiscovery.preferredWorkspace()
    }),
    playTestSound: (trigger) => playMacNotificationSound(trigger),
    toggleDictation: () => dictationManager?.toggle(),
    performDictationAction: (action, text) => dictationManager?.performAction(action, text),
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
    integrationStatus.cursor.installed ||
    integrationStatus.hermes.installed ||
    integrationStatus.claudeclaw.installed
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
    recoveryTray?.destroy()
    recoveryTray = undefined
    dictationManager?.destroy()
    dictationManager = undefined
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
