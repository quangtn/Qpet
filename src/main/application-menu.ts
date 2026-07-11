import { app, Menu } from 'electron'

interface ApplicationMenuActions {
  showSettings(): void
  showPet(): void
  toggleTray(): void
}

export function installApplicationMenu(actions: ApplicationMenuActions): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'QPet',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Show QPet',
            click: actions.showPet
          },
          {
            label: 'Show Activity',
            accelerator: 'CommandOrControl+Shift+P',
            click: actions.toggleTray
          },
          {
            label: 'Settings…',
            accelerator: 'CommandOrControl+,',
            click: actions.showSettings
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          {
            label: 'Quit QPet',
            accelerator: 'CommandOrControl+Q',
            click: () => app.quit()
          }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'Window',
        submenu: [{ role: 'close' }, { role: 'minimize' }, { role: 'front' }]
      }
    ])
  )
}

