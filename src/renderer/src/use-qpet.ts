import { useCallback, useEffect, useState } from 'react'
import type {
  ActionResult,
  AppSettings,
  AppSnapshot,
  InstallResult,
  IntegrationStatus,
  SessionActionRequest
} from '@shared'

const emptySnapshot: AppSnapshot = {
  activities: [],
  integrations: {
    listenerActive: false,
    listenerMessage: 'Checking QPet’s local event listener…',
    codex: {
      provider: 'codex',
      health: 'unavailable',
      installed: false,
      message: 'Checking Codex…'
    },
    claude: {
      provider: 'claude',
      health: 'unavailable',
      installed: false,
      message: 'Checking Claude Code…'
    },
    cursor: {
      provider: 'cursor',
      health: 'unavailable',
      installed: false,
      message: 'Checking Cursor…'
    }
  },
  settings: {
    launchAtLogin: true,
    systemNotifications: true,
    soundNotifications: true,
    petVisible: true,
    petTheme: 'classic'
  },
  appVersion: '…'
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'QPet could not complete that action.'
}

export interface QPetController {
  snapshot: AppSnapshot
  loading: boolean
  error?: string
  reload(): Promise<void>
  markRead(activityId?: string): Promise<void>
  dismiss(activityId: string): Promise<void>
  performAction(request: SessionActionRequest): Promise<ActionResult>
  install(): Promise<InstallResult>
  uninstall(): Promise<InstallResult>
  refreshIntegrations(): Promise<IntegrationStatus>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}

export function useQPet(): QPetController {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const reload = useCallback(async () => {
    try {
      const next = await window.qpet.getSnapshot()
      setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.qpet
      .getSnapshot()
      .then((next) => {
        if (active) {
          setSnapshot(next)
          setError(undefined)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    const unsubscribe = window.qpet.onSnapshot((next) => {
      if (active) {
        setSnapshot(next)
        setError(undefined)
        setLoading(false)
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const markRead = useCallback(async (activityId?: string) => {
    await window.qpet.markRead(activityId)
    setSnapshot((current) => ({
      ...current,
      activities: current.activities.map((activity) =>
        (!activityId || activity.id === activityId) && activity.state === 'ready'
          ? { ...activity, unread: false }
          : activity
      )
    }))
  }, [])

  const dismiss = useCallback(async (activityId: string) => {
    await window.qpet.dismiss(activityId)
    setSnapshot((current) => ({
      ...current,
      activities: current.activities.filter((activity) => activity.id !== activityId)
    }))
  }, [])

  const performAction = useCallback(async (request: SessionActionRequest) => {
    const result = await window.qpet.performSessionAction(request)
    if (!result.ok) setError(result.message)
    return result
  }, [])

  const install = useCallback(async () => {
    const result = await window.qpet.installIntegrations()
    setSnapshot((current) => ({ ...current, integrations: result.status }))
    if (!result.ok) setError(result.message)
    return result
  }, [])

  const uninstall = useCallback(async () => {
    const result = await window.qpet.uninstallIntegrations()
    setSnapshot((current) => ({ ...current, integrations: result.status }))
    if (!result.ok) setError(result.message)
    return result
  }, [])

  const refreshIntegrations = useCallback(async () => {
    const integrations = await window.qpet.refreshIntegrations()
    setSnapshot((current) => ({ ...current, integrations }))
    setError(undefined)
    return integrations
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const settings = await window.qpet.updateSettings(patch)
    setSnapshot((current) => ({ ...current, settings }))
    return settings
  }, [])

  return {
    snapshot,
    loading,
    error,
    reload,
    markRead,
    dismiss,
    performAction,
    install,
    uninstall,
    refreshIntegrations,
    updateSettings
  }
}
