export type Provider = 'codex' | 'claude' | 'cursor'

export type PetState = 'running' | 'needs_input' | 'ready' | 'blocked'
export type PetTheme = 'classic' | 'qmini'
export type SoundTrigger = 'needs_input' | 'blocked' | 'ready'
export type DictationState = 'idle' | 'listening' | 'transcribing' | 'reviewing' | 'copied' | 'error'
export type DictationAction = 'copy' | 'retry' | 'cancel'

export interface DictationStatus {
  state: DictationState
  shortcut: string
  message?: string
  /** Transient renderer-only preview. Never persisted. */
  preview?: string
}

export type IntegrationHealth =
  | 'not_installed'
  | 'awaiting_trust'
  | 'healthy'
  | 'unavailable'
  | 'error'

export interface Activity {
  id: string
  provider: Provider
  sessionId: string
  cwd: string
  projectName: string
  state: PetState
  summary: string
  updatedAt: number
  unread: boolean
  live: boolean
  backgroundJobId?: string
}

export interface IntegrationDetail {
  provider: Provider
  health: IntegrationHealth
  installed: boolean
  binaryPath?: string
  version?: string
  message?: string
}

export interface IntegrationStatus {
  codex: IntegrationDetail
  claude: IntegrationDetail
  cursor: IntegrationDetail
  listenerActive: boolean
  /** Present when the loopback event listener failed to start or is down. */
  listenerMessage?: string
}

export interface AppSettings {
  launchAtLogin: boolean
  systemNotifications: boolean
  soundNotifications: boolean
  soundTriggers: SoundTrigger[]
  dictationEnabled: boolean
  dictationSounds: boolean
  petVisible: boolean
  petTheme: PetTheme
  petPosition?: { x: number; y: number }
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface AppSnapshot {
  activities: Activity[]
  integrations: IntegrationStatus
  settings: AppSettings
  dictation: DictationStatus
  appVersion: string
}

export type SessionAction = 'open_project' | 'attach' | 'resume' | 'copy_command'

export interface SessionActionRequest {
  activityId: string
  action: SessionAction
}

export interface ActionResult {
  ok: boolean
  message: string
}

export interface InstallResult extends ActionResult {
  status: IntegrationStatus
}

export interface QPetApi {
  getSnapshot(): Promise<AppSnapshot>
  markRead(activityId?: string): Promise<void>
  dismiss(activityId: string): Promise<void>
  performSessionAction(request: SessionActionRequest): Promise<ActionResult>
  installIntegrations(): Promise<InstallResult>
  uninstallIntegrations(): Promise<InstallResult>
  refreshIntegrations(): Promise<IntegrationStatus>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  beginPetDrag(point: ScreenPoint): Promise<void>
  movePetDrag(point: ScreenPoint): Promise<void>
  endPetDrag(): Promise<void>
  openProviderApp(provider: Provider): Promise<ActionResult>
  playTestSound(trigger: SoundTrigger): Promise<void>
  toggleDictation(): Promise<void>
  performDictationAction(action: DictationAction, text?: string): Promise<void>
  toggleTray(): Promise<void>
  showSettings(): Promise<void>
  hideTray(): Promise<void>
  quit(): Promise<void>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}
