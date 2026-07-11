import { app, Menu, nativeImage, Tray } from 'electron'

interface RecoveryTrayActions {
  showPet(): void
  showActivity(): void
  showSettings(): void
}

/** A menu-bar recovery point used only while the accessory pet is hidden. */
export class RecoveryTray {
  private tray: Tray | undefined

  constructor(
    private readonly iconPath: string,
    private readonly actions: RecoveryTrayActions
  ) {}

  setPetVisible(visible: boolean): void {
    if (visible) {
      this.destroy()
      return
    }
    if (this.tray) return

    const icon = nativeImage.createFromPath(this.iconPath).resize({
      width: 18,
      height: 18,
      quality: 'best'
    })
    this.tray = new Tray(icon)
    this.tray.setToolTip('QPet — floating pet hidden')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Floating Pet', click: this.actions.showPet },
        { label: 'Show Activity', click: this.actions.showActivity },
        { label: 'Settings…', click: this.actions.showSettings },
        { type: 'separator' },
        { label: 'Quit QPet', click: () => app.quit() }
      ])
    )
    this.tray.on('click', this.actions.showPet)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
