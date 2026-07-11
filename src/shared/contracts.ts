export type Provider = 'codex' | 'claude' | 'cursor'

export type PetState = 'running' | 'needs_input' | 'ready' | 'blocked'

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
}

export interface AppSettings {
  launchAtLogin: boolean
  systemNotifications: boolean
  soundNotifications: boolean
  petVisible: boolean
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
  playTestSound(): Promise<void>
  toggleTray(): Promise<void>
  showSettings(): Promise<void>
  hideTray(): Promise<void>
  quit(): Promise<void>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}
