import { app, BrowserWindow, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { AppSettings, AppSnapshot, ScreenPoint } from '@shared'
import { IPC } from '@shared'

const PET_WIDTH = 190
const PET_HEIGHT = 112
const TRAY_WIDTH = 520
const TRAY_HEIGHT = 650
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

interface WindowManagerOptions {
  preloadPath: string
  getSettings: () => AppSettings
  savePetPosition: (position: { x: number; y: number }) => Promise<void>
  onTrayOpened: () => void
}

export class WindowManager {
  private petWindow: BrowserWindow | null = null
  private trayWindow: BrowserWindow | null = null
  private settingsWindow: BrowserWindow | null = null
  private settingsRoute: 'settings' | 'onboarding' = 'settings'
  private moveTimer: NodeJS.Timeout | null = null
  private petDragOffset: ScreenPoint | null = null

  constructor(private readonly options: WindowManagerOptions) {}

  create(): void {
    if (this.petWindow && !this.petWindow.isDestroyed()) return

    const position = this.initialPetPosition()
    this.petWindow = new BrowserWindow({
      width: PET_WIDTH,
      height: PET_HEIGHT,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      hasShadow: false,
      skipTaskbar: true,
      title: 'QPet',
      webPreferences: this.webPreferences()
    })
    this.petWindow.setAlwaysOnTop(true, 'screen-saver')
    this.petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.petWindow.setWindowButtonVisibility(false)
    this.lockNavigation(this.petWindow)
    this.loadRoute(this.petWindow, 'pet')
    this.petWindow.once('ready-to-show', () => {
      if (this.options.getSettings().petVisible) this.petWindow?.showInactive()
    })
    this.petWindow.on('move', () => this.schedulePositionSave())
    this.petWindow.on('closed', () => {
      this.petWindow = null
    })

    this.trayWindow = new BrowserWindow({
      width: TRAY_WIDTH,
      height: TRAY_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      hasShadow: true,
      skipTaskbar: true,
      title: 'QPet Activity',
      webPreferences: this.webPreferences()
    })
    this.trayWindow.setAlwaysOnTop(true, 'screen-saver')
    this.trayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.lockNavigation(this.trayWindow)
    this.loadRoute(this.trayWindow, 'tray')
    this.trayWindow.on('blur', () => {
      if (!this.settingsWindow?.isVisible()) this.trayWindow?.hide()
    })
    this.trayWindow.on('closed', () => {
      this.trayWindow = null
    })

    screen.on('display-removed', this.clampPetToDisplay)
    screen.on('display-metrics-changed', this.clampPetToDisplay)
  }

  toggleTray(): void {
    if (!this.trayWindow || !this.petWindow) return
    if (this.trayWindow.isVisible()) {
      this.trayWindow.hide()
      return
    }

    this.positionTray()
    this.trayWindow.show()
    this.trayWindow.focus()
    this.options.onTrayOpened()
  }

  hideTray(): void {
    this.trayWindow?.hide()
  }

  beginPetDrag(point: ScreenPoint): void {
    if (!this.petWindow || this.petWindow.isDestroyed()) return
    const [x, y] = this.petWindow.getPosition()
    this.petDragOffset = { x: point.x - x, y: point.y - y }
  }

  movePetDrag(point: ScreenPoint): void {
    if (!this.petWindow || this.petWindow.isDestroyed() || !this.petDragOffset) return
    const position = this.clampedPosition(
      point.x - this.petDragOffset.x,
      point.y - this.petDragOffset.y
    )
    this.petWindow.setPosition(position.x, position.y, false)
  }

  endPetDrag(): void {
    if (!this.petDragOffset) return
    this.petDragOffset = null
    this.schedulePositionSave()
  }

  showSettings(): void {
    this.openSettingsWindow('settings')
  }

  showOnboarding(): void {
    this.openSettingsWindow('onboarding')
  }

  private openSettingsWindow(route: 'settings' | 'onboarding'): void {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) {
      this.settingsRoute = route
      this.settingsWindow = new BrowserWindow({
        width: route === 'onboarding' ? 620 : 720,
        height: route === 'onboarding' ? 720 : 780,
        minWidth: route === 'onboarding' ? 520 : 620,
        minHeight: route === 'onboarding' ? 640 : 680,
        title: route === 'onboarding' ? 'Welcome to QPet' : 'QPet Settings',
        backgroundColor: '#f7f4ef',
        show: false,
        webPreferences: this.webPreferences()
      })
      this.lockNavigation(this.settingsWindow)
      this.loadRoute(this.settingsWindow, route)
      this.settingsWindow.on('closed', () => {
        this.settingsWindow = null
      })
    } else if (this.settingsRoute !== route) {
      this.settingsRoute = route
      this.loadRoute(this.settingsWindow, route)
    }

    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show())
    if (!this.settingsWindow.webContents.isLoading()) this.settingsWindow.show()
    this.settingsWindow.focus()
  }

  setPetVisible(visible: boolean): void {
    if (!this.petWindow) return
    if (visible) this.petWindow.showInactive()
    else {
      this.petWindow.hide()
      this.trayWindow?.hide()
    }
  }

  broadcast(snapshot: AppSnapshot): void {
    for (const window of [this.petWindow, this.trayWindow, this.settingsWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC.snapshotChanged, snapshot)
      }
    }
  }

  destroy(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.petDragOffset = null
    screen.removeListener('display-removed', this.clampPetToDisplay)
    screen.removeListener('display-metrics-changed', this.clampPetToDisplay)
    this.settingsWindow?.destroy()
    this.trayWindow?.destroy()
    this.petWindow?.destroy()
  }

  private webPreferences() {
    return {
      preload: this.options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  }

  private loadRoute(
    window: BrowserWindow,
    route: 'pet' | 'tray' | 'settings' | 'onboarding'
  ): void {
    const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      const url = new URL(devUrl)
      url.searchParams.set('window', route)
      void window.loadURL(url.toString())
      return
    }

    void window.loadFile(join(MODULE_DIRECTORY, '../renderer/index.html'), {
      query: { window: route }
    })
  }

  private lockNavigation(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
  }

  private initialPetPosition(): { x: number; y: number } {
    const saved = this.options.getSettings().petPosition
    if (saved) return this.clampedPosition(saved.x, saved.y)
    const workArea = screen.getPrimaryDisplay().workArea
    return {
      x: workArea.x + workArea.width - PET_WIDTH - 24,
      y: workArea.y + workArea.height - PET_HEIGHT - 24
    }
  }

  private positionTray(): void {
    if (!this.petWindow || !this.trayWindow) return
    const petBounds = this.petWindow.getBounds()
    const display = screen.getDisplayMatching(petBounds)
    const workArea = display.workArea
    const gap = 10
    let x = petBounds.x - TRAY_WIDTH - gap
    if (x < workArea.x) x = petBounds.x + petBounds.width + gap
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - TRAY_WIDTH)
    const y = Math.min(
      Math.max(petBounds.y + petBounds.height - TRAY_HEIGHT, workArea.y),
      workArea.y + workArea.height - TRAY_HEIGHT
    )
    this.trayWindow.setPosition(Math.round(x), Math.round(y), false)
  }

  private schedulePositionSave(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = setTimeout(() => {
      if (!this.petWindow) return
      const [x, y] = this.petWindow.getPosition()
      void this.options.savePetPosition({ x, y })
    }, 250)
  }

  private readonly clampPetToDisplay = (): void => {
    if (!this.petWindow) return
    const [x, y] = this.petWindow.getPosition()
    const clamped = this.clampedPosition(x, y)
    if (clamped.x !== x || clamped.y !== y) {
      this.petWindow.setPosition(clamped.x, clamped.y, false)
    }
  }

  private clampedPosition(x: number, y: number): { x: number; y: number } {
    const display = screen.getDisplayNearestPoint({ x, y })
    const workArea = display.workArea
    return {
      x: Math.min(Math.max(Math.round(x), workArea.x), workArea.x + workArea.width - PET_WIDTH),
      y: Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - PET_HEIGHT)
    }
  }
}
