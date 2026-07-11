import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QPetApi } from '../../src/shared/contracts'

const PRELOAD_ALLOWLIST = [
  'beginPetDrag',
  'dismiss',
  'endPetDrag',
  'getSnapshot',
  'hideTray',
  'installIntegrations',
  'markRead',
  'movePetDrag',
  'onSnapshot',
  'openProviderApp',
  'performSessionAction',
  'playTestSound',
  'quit',
  'refreshIntegrations',
  'showSettings',
  'toggleTray',
  'uninstallIntegrations',
  'updateSettings'
]

async function pageFor(app: ElectronApplication, mode: string): Promise<Page> {
  let page: Page | undefined
  await expect.poll(() => {
    page = app.windows().find((candidate) => {
      try {
        const url = new URL(candidate.url())
        return url.searchParams.get('window') === mode
      } catch {
        return false
      }
    })
    return Boolean(page)
  }).toBe(true)
  if (!page) throw new Error(`QPet ${mode} window was not created`)
  return page
}

async function trayIsVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const tray = BrowserWindow.getAllWindows().find((candidate) => {
      const url = new URL(candidate.webContents.getURL())
      return url.searchParams.get('window') === 'tray'
    })
    return tray?.isVisible() ?? false
  })
}

test('normalizes provider events and prioritizes the floating pet activity tray', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'qpet-e2e-'))
  const fakeHome = join(userData, 'home')
  await mkdir(fakeHome, { recursive: true })

  const electronApp = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      QPET_USER_DATA_DIR: userData,
      QPET_HOME_DIR: fakeHome,
      QPET_TEST_MODE: '1',
      QPET_DISABLE_POLLING: '1',
      QPET_SKIP_ONBOARDING: '1'
    }
  })

  try {
    const pet = await pageFor(electronApp, 'pet')
    const tray = await pageFor(electronApp, 'tray')
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'sleeping')
    await expect(pet.getByTestId('provider-status-codex')).toHaveCount(0)
    await expect(pet.getByTestId('provider-status-claude')).toHaveCount(0)
    const petWindowBehavior = await electronApp.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!window) throw new Error('Pet window is missing')
      return {
        alwaysOnTop: window.isAlwaysOnTop(),
        visibleOnAllWorkspaces: window.isVisibleOnAllWorkspaces(),
        dockVisible: app.dock?.isVisible() ?? false
      }
    })
    expect(petWindowBehavior).toEqual({
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      dockVisible: false
    })
    const petBounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!window) throw new Error('Pet window is missing')
      return window.getBounds()
    })
    expect(petBounds).toMatchObject({ width: 190, height: 112 })

    const rendererSurface = await pet.evaluate(() => {
      const globals = globalThis as unknown as Record<string, unknown> & { qpet: QPetApi }
      return {
        apiKeys: Object.keys(globals.qpet).sort(),
        nodeGlobals: {
          Buffer: typeof globals.Buffer,
          global: typeof globals.global,
          module: typeof globals.module,
          process: typeof globals.process,
          require: typeof globals.require
        }
      }
    })
    expect(rendererSurface.apiKeys).toEqual(PRELOAD_ALLOWLIST)
    expect(rendererSurface.nodeGlobals).toEqual({
      Buffer: 'undefined',
      global: 'undefined',
      module: 'undefined',
      process: 'undefined',
      require: 'undefined'
    })

    const petImage = pet.locator('.pet-sprite')
    await expect(petImage).toBeVisible()
    await expect(pet.locator('.robot-antenna')).toHaveCount(0)
    await expect(pet.locator('.robot-panel')).toHaveCount(0)
    await expect(pet.locator('.pet-drag-zone')).toHaveCount(0)
    await expect
      .poll(() =>
        petImage.evaluate(
          (image) => (image as unknown as { naturalWidth: number }).naturalWidth
        )
      )
      .toBeGreaterThan(0)

    await pet.emulateMedia({ reducedMotion: 'reduce' })
    const reducedMotion = await petImage.evaluate((image) => {
      const pageGlobal = globalThis as unknown as {
        getComputedStyle(element: unknown): {
          animationDuration: string
          animationIterationCount: string
        }
        matchMedia(query: string): { matches: boolean }
      }
      const style = pageGlobal.getComputedStyle(image)
      const duration = style.animationDuration
      const durationMs = duration.endsWith('ms')
        ? Number.parseFloat(duration)
        : Number.parseFloat(duration) * 1_000
      return {
        mediaMatches: pageGlobal.matchMedia('(prefers-reduced-motion: reduce)').matches,
        durationMs,
        iterationCount: style.animationIterationCount
      }
    })
    expect(reducedMotion).toEqual({
      mediaMatches: true,
      durationMs: 0.001,
      iterationCount: '1'
    })

    await pet.evaluate(() =>
      (globalThis as unknown as { qpet: QPetApi }).qpet.showSettings()
    )
    const settings = await pageFor(electronApp, 'settings')
    await expect(settings.getByTestId('settings-window')).toBeVisible()
    await expect(settings.locator('.integration-card')).toHaveCount(3)
    await expect(settings.getByRole('radio')).toHaveCount(2)
    await settings.getByRole('radio', { name: /Qmini/ }).click()
    await expect(settings.getByRole('radio', { name: /Qmini/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(pet.getByTestId('pet-window')).toHaveAttribute('data-theme', 'qmini')
    await expect(pet.locator('.pet-sprite')).toHaveAttribute(
      'src',
      './pets/qmini/states/sleeping.png'
    )
    await expect(pet.locator('.pet-sprite')).toHaveCSS('image-rendering', 'auto')
    await settings.getByRole('radio', { name: /Classic/ }).click()
    await expect(settings.getByRole('radio', { name: /Classic/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(pet.getByTestId('pet-window')).toHaveAttribute('data-theme', 'classic')
    const settingsMetrics = await settings.evaluate(() => {
      const pageGlobal = globalThis as unknown as {
        document: { querySelector(selector: string): unknown }
        getComputedStyle(element: unknown): { fontSize: string }
      }
      const readFontSize = (selector: string): number => {
        const element = pageGlobal.document.querySelector(selector)
        if (!element) throw new Error(`Missing settings element: ${selector}`)
        return Number.parseFloat(pageGlobal.getComputedStyle(element).fontSize)
      }
      return {
        sectionTitle: readFontSize('.settings-section-title h2'),
        settingTitle: readFontSize('.setting-row strong'),
        integrationTitle: readFontSize('.integration-card-title strong')
      }
    })
    expect(settingsMetrics).toEqual({
      sectionTitle: 15,
      settingTitle: 13,
      integrationTitle: 14
    })
    const settingsBounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'settings'
      })
      if (!window) throw new Error('Settings window is missing')
      return window.getBounds()
    })
    expect(settingsBounds.width).toBeGreaterThanOrEqual(720)
    expect(settingsBounds.height).toBeGreaterThanOrEqual(780)
    const settingsClosed = settings.waitForEvent('close')
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await settingsClosed

    const endpoint = JSON.parse(
      await readFile(join(userData, 'event-endpoint.json'), 'utf8')
    ) as { baseUrl: string }
    const token = await readFile(join(userData, 'event-token'), 'utf8')

    const postEvent = async (provider: 'codex' | 'claude' | 'cursor', payload: object): Promise<void> => {
      const response = await fetch(`${endpoint.baseUrl}/v1/events/${provider}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
      expect(response.status).toBe(204)
    }

    await postEvent('codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-e2e',
      cwd: '/tmp/qpet-codex',
      prompt: 'This sensitive prompt must never appear in the UI or cache.'
    })
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'running')
    await expect(pet.getByTestId('provider-status-codex')).toHaveText('Codex1 Working')
    await expect(pet.locator('.provider-statuses')).toHaveAttribute('data-count', '1')
    await expect(pet.locator('.provider-statuses')).toHaveCSS('top', '46px')
    await expect(pet.getByTestId('provider-status-codex')).toHaveAttribute(
      'aria-label',
      'Open Codex Desktop'
    )
    await expect(pet.getByTestId('provider-status-codex')).toHaveCSS('pointer-events', 'auto')

    await postEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'claude-e2e',
      cwd: '/tmp/qpet-claude',
      tool_input: { command: 'secret-command --token hidden' }
    })
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'needs_input')
    await expect(pet.getByTestId('provider-status-claude')).toHaveText('Claude1 Needs input')
    await expect(pet.locator('.provider-statuses')).toHaveAttribute('data-count', '2')
    await expect(pet.locator('.provider-statuses')).toHaveCSS('top', '26px')
    await expect(pet.getByTestId('provider-status-claude')).toHaveAttribute(
      'aria-label',
      'Open Claude Desktop'
    )

    await pet.getByTestId('pet').click()
    const cards = tray.getByTestId('activity-card')
    await expect(cards).toHaveCount(2)
    const trayBounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'tray'
      })
      if (!window) throw new Error('Activity tray is missing')
      return window.getBounds()
    })
    expect(trayBounds.width).toBeGreaterThanOrEqual(520)
    expect(trayBounds.height).toBeGreaterThanOrEqual(650)
    const trayTypography = await tray.evaluate(() => {
      const pageGlobal = globalThis as unknown as {
        document: { querySelector(selector: string): unknown }
        getComputedStyle(element: unknown): { fontSize: string }
      }
      const readFontSize = (selector: string): number => {
        const element = pageGlobal.document.querySelector(selector)
        if (!element) throw new Error(`Missing tray element: ${selector}`)
        return Number.parseFloat(pageGlobal.getComputedStyle(element).fontSize)
      }
      return {
        heading: readFontSize('.activity-heading h1'),
        activity: readFontSize('.activity-title strong')
      }
    })
    expect(trayTypography).toEqual({ heading: 22, activity: 15 })
    await expect(cards.first()).toHaveAttribute('data-provider', 'claude')
    await expect(cards.first()).toHaveAttribute('data-state', 'needs_input')
    await expect(tray.getByText('secret-command')).toHaveCount(0)
    await expect(tray.getByText('sensitive prompt')).toHaveCount(0)

    await postEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'claude-e2e',
      cwd: '/tmp/qpet-claude',
      last_assistant_message: 'Sensitive result'
    })
    await postEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'codex-e2e',
      cwd: '/tmp/qpet-codex',
      last_assistant_message: 'Another sensitive result'
    })
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'ready')
    await expect(pet.getByTestId('provider-status-codex')).toHaveText('Codex1 Ready')
    await expect(pet.getByTestId('provider-status-claude')).toHaveText('Claude1 Ready')

    await postEvent('claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-e2e-live',
      cwd: '/tmp/qpet-claude-live'
    })
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'running')
    await expect(pet.getByTestId('provider-status-claude')).toHaveText('Claude1 Working')
    await expect(pet.getByTestId('provider-status-codex')).toHaveCSS(
      'background-color',
      'rgb(50, 111, 185)'
    )
    await expect(pet.getByTestId('provider-status-claude')).toHaveCSS(
      'background-color',
      'rgb(194, 101, 54)'
    )

    await postEvent('cursor', {
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'cursor-e2e',
      workspace_roots: ['/tmp/qpet-cursor'],
      prompt: 'Private Cursor prompt'
    })
    await expect(pet.getByTestId('provider-status-cursor')).toHaveText('Cursor1 Working')
    await expect(pet.getByTestId('provider-status-cursor')).toHaveAttribute(
      'aria-label',
      'Open Cursor Desktop'
    )
    await expect(pet.getByTestId('provider-status-cursor')).toHaveCSS(
      'background-color',
      'rgb(92, 88, 168)'
    )
    await expect(pet.locator('.provider-statuses')).toHaveAttribute('data-count', '3')
    await expect(pet.locator('.provider-statuses')).toHaveCSS('top', '7px')
  } finally {
    await electronApp.close()
  }
})

test('keeps the accessory pet pinned through a native fullscreen Space transition', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'qpet-e2e-fullscreen-'))
  const fakeHome = join(userData, 'home')
  await mkdir(fakeHome, { recursive: true })
  const electronApp = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      QPET_USER_DATA_DIR: userData,
      QPET_HOME_DIR: fakeHome,
      QPET_TEST_MODE: '1',
      QPET_DISABLE_POLLING: '1',
      QPET_SKIP_ONBOARDING: '1'
    }
  })

  try {
    await pageFor(electronApp, 'pet')
    const result = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!pet) throw new Error('Pet window is missing')

      const probe = new BrowserWindow({
        width: 640,
        height: 420,
        show: false,
        fullscreenable: true,
        backgroundColor: '#20242b'
      })
      const waitForTransition = (
        event: 'enter-full-screen' | 'leave-full-screen'
      ): Promise<boolean> => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000)
        const complete = (): void => {
          clearTimeout(timer)
          resolve(true)
        }
        if (event === 'enter-full-screen') probe.once('enter-full-screen', complete)
        else probe.once('leave-full-screen', complete)
      })

      try {
        await probe.loadURL('data:text/html,<title>QPet fullscreen probe</title>')
        probe.show()
        const before = pet.getBounds()
        const entered = waitForTransition('enter-full-screen')
        probe.setFullScreen(true)
        const didEnter = await entered
        const during = {
          bounds: pet.getBounds(),
          visible: pet.isVisible(),
          alwaysOnTop: pet.isAlwaysOnTop(),
          visibleOnAllWorkspaces: pet.isVisibleOnAllWorkspaces()
        }
        const left = waitForTransition('leave-full-screen')
        probe.setFullScreen(false)
        const didLeave = await left
        return { before, during, after: pet.getBounds(), didEnter, didLeave }
      } finally {
        probe.destroy()
      }
    })

    expect(result.didEnter).toBe(true)
    expect(result.didLeave).toBe(true)
    expect(result.during).toMatchObject({
      bounds: result.before,
      visible: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true
    })
    expect(result.after).toEqual(result.before)
  } finally {
    await electronApp.close()
  }
})

test('paginates compact activity rows in groups of twelve', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'qpet-e2e-pagination-'))
  const fakeHome = join(userData, 'home')
  await mkdir(fakeHome, { recursive: true })
  const now = Date.now()
  await writeFile(
    join(userData, 'activities.json'),
    `${JSON.stringify({
      version: 1,
      activities: Array.from({ length: 13 }, (_, index) => ({
        provider: index % 2 === 0 ? 'codex' : 'claude',
        sessionId: `page-session-${index}`,
        cwd: `/tmp/project-${index}`,
        state: 'ready',
        summary: 'Work finished',
        updatedAt: now - index * 1_000,
        unread: true,
        live: false
      }))
    })}\n`,
    { mode: 0o600 }
  )

  const electronApp = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      QPET_USER_DATA_DIR: userData,
      QPET_HOME_DIR: fakeHome,
      QPET_TEST_MODE: '1',
      QPET_DISABLE_POLLING: '1',
      QPET_SKIP_ONBOARDING: '1'
    }
  })

  try {
    const pet = await pageFor(electronApp, 'pet')
    const tray = await pageFor(electronApp, 'tray')
    await pet.getByTestId('pet').click()
    await expect(tray.getByTestId('activity-card')).toHaveCount(12)
    await expect(tray.getByText('Page 1 of 2')).toBeVisible()
    await expect(tray.getByRole('button', { name: 'Previous' })).toBeDisabled()

    await tray.getByRole('button', { name: 'Next' }).click()
    await expect(tray.getByText('Page 2 of 2')).toBeVisible()
    await expect(tray.getByTestId('activity-card')).toHaveCount(1)
    await expect(tray.getByText('project-12')).toBeVisible()

    await tray.getByRole('button', { name: 'Dismiss project-12' }).click()
    await expect(tray.getByTestId('activity-card')).toHaveCount(12)
    await expect(tray.getByRole('navigation', { name: 'Activity pages' })).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('keeps completed work unread while the tray is hidden and acknowledges it on open', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'qpet-e2e-ready-'))
  const fakeHome = join(userData, 'home')
  await mkdir(fakeHome, { recursive: true })
  await writeFile(
    join(userData, 'activities.json'),
    `${JSON.stringify({
      version: 1,
      activities: [
        {
          provider: 'claude',
          sessionId: 'persisted-ready',
          cwd: '/tmp/qpet-ready-project',
          state: 'ready',
          summary: 'Claude task completed',
          updatedAt: Date.now(),
          unread: true,
          live: false
        }
      ]
    })}\n`,
    { mode: 0o600 }
  )

  const electronApp = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      QPET_USER_DATA_DIR: userData,
      QPET_HOME_DIR: fakeHome,
      QPET_TEST_MODE: '1',
      QPET_DISABLE_POLLING: '1',
      QPET_SKIP_ONBOARDING: '1'
    }
  })

  try {
    const pet = await pageFor(electronApp, 'pet')
    const tray = await pageFor(electronApp, 'tray')
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'ready')
    await expect(pet.getByTestId('provider-status-claude')).toHaveText('Claude1 Ready')
    await expect(tray.getByTestId('activity-card')).toHaveCount(1)
    await expect.poll(() => trayIsVisible(electronApp)).toBe(false)

    const unreadWhileHidden = await tray.evaluate(async () => {
      const api = (globalThis as unknown as { qpet: QPetApi }).qpet
      // This no-op mutation is an ordering barrier for any renderer mount effects.
      await api.markRead('__qpet_e2e_barrier__')
      const snapshot = await api.getSnapshot()
      return snapshot.activities.find((activity) => activity.sessionId === 'persisted-ready')
        ?.unread
    })
    expect(unreadWhileHidden).toBe(true)

    await pet.getByTestId('pet').click()
    await expect.poll(() => trayIsVisible(electronApp)).toBe(true)
    await expect
      .poll(async () => {
        const snapshot = await pet.evaluate(() =>
          (globalThis as unknown as { qpet: QPetApi }).qpet.getSnapshot()
        )
        return snapshot.activities.find(
          (activity) => activity.sessionId === 'persisted-ready'
        )?.unread
      })
      .toBe(false)
    await expect(tray.locator('.unread-dot')).toHaveCount(0)
    await expect(pet.getByTestId('pet')).toHaveAttribute('data-state', 'sleeping')
    await expect(pet.getByTestId('provider-status-claude')).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('persists pet moves and clamps an offscreen saved position on restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'qpet-e2e-position-'))
  const fakeHome = join(userData, 'home')
  await mkdir(fakeHome, { recursive: true })
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    QPET_USER_DATA_DIR: userData,
    QPET_HOME_DIR: fakeHome,
    QPET_TEST_MODE: '1',
    QPET_DISABLE_POLLING: '1',
    QPET_SKIP_ONBOARDING: '1'
  }

  let firstApp: ElectronApplication | undefined = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    cwd: process.cwd(),
    env: environment
  })

  try {
    const pet = await pageFor(firstApp, 'pet')
    await expect.poll(() => trayIsVisible(firstApp!)).toBe(false)
    const initialBounds = await firstApp.evaluate(({ BrowserWindow }) => {
      const petWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!petWindow) throw new Error('Pet window is missing')
      return petWindow.getBounds()
    })
    const spriteBox = await pet.locator('.pet-sprite').boundingBox()
    if (!spriteBox) throw new Error('Pet sprite is not visible')
    await pet.mouse.move(spriteBox.x + spriteBox.width / 2, spriteBox.y + spriteBox.height / 2)
    await pet.mouse.down()
    await pet.mouse.move(spriteBox.x + spriteBox.width / 2 + 24, spriteBox.y + spriteBox.height / 2 + 18)
    await pet.mouse.up()
    await expect.poll(async () => {
      const bounds = await firstApp!.evaluate(({ BrowserWindow }) => {
        const petWindow = BrowserWindow.getAllWindows().find((candidate) => {
          const url = new URL(candidate.webContents.getURL())
          return url.searchParams.get('window') === 'pet'
        })
        if (!petWindow) throw new Error('Pet window is missing')
        return petWindow.getBounds()
      })
      return bounds.x !== initialBounds.x || bounds.y !== initialBounds.y
    }).toBe(true)
    const target = await firstApp.evaluate(({ BrowserWindow }) => {
      const petWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!petWindow) throw new Error('Pet window is missing')
      return petWindow.getBounds()
    })

    const movedWindowBehavior = await firstApp.evaluate(({ BrowserWindow }) => {
      const petWindow = BrowserWindow.getAllWindows().find((candidate) => {
        const url = new URL(candidate.webContents.getURL())
        return url.searchParams.get('window') === 'pet'
      })
      if (!petWindow) throw new Error('Pet window is missing after drag')
      return {
        alwaysOnTop: petWindow.isAlwaysOnTop(),
        visibleOnAllWorkspaces: petWindow.isVisibleOnAllWorkspaces(),
        visible: petWindow.isVisible()
      }
    })
    expect(movedWindowBehavior).toEqual({
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      visible: true
    })

    await expect
      .poll(async () => {
        try {
          const settings = JSON.parse(
            await readFile(join(userData, 'settings.json'), 'utf8')
          ) as { petPosition?: { x: number; y: number } }
          return settings.petPosition
        } catch {
          return undefined
        }
      })
      .toEqual({ x: target.x, y: target.y })
    await expect.poll(() => trayIsVisible(firstApp!)).toBe(false)

    await firstApp.close()
    firstApp = undefined

    await writeFile(
      join(userData, 'settings.json'),
      `${JSON.stringify({
        launchAtLogin: true,
        systemNotifications: true,
        soundNotifications: true,
        petVisible: true,
        petPosition: { x: 999_999, y: 999_999 }
      })}\n`,
      { mode: 0o600 }
    )

    const restartedApp = await electron.launch({
      args: [join(process.cwd(), 'out/main/index.js')],
      cwd: process.cwd(),
      env: environment
    })
    try {
      await pageFor(restartedApp, 'pet')
      const placement = await restartedApp.evaluate(({ BrowserWindow, screen }) => {
        const petWindow = BrowserWindow.getAllWindows().find((candidate) => {
          const url = new URL(candidate.webContents.getURL())
          return url.searchParams.get('window') === 'pet'
        })
        if (!petWindow) throw new Error('Pet window is missing after restart')
        return {
          bounds: petWindow.getBounds(),
          workAreas: screen.getAllDisplays().map((display) => display.workArea)
        }
      })

      expect(
        placement.workAreas.some(
          (area) =>
            placement.bounds.x >= area.x &&
            placement.bounds.y >= area.y &&
            placement.bounds.x + placement.bounds.width <= area.x + area.width &&
            placement.bounds.y + placement.bounds.height <= area.y + area.height
        )
      ).toBe(true)
      expect(placement.bounds.x).toBeLessThan(999_999)
      expect(placement.bounds.y).toBeLessThan(999_999)
    } finally {
      await restartedApp.close()
    }
  } finally {
    if (firstApp) await firstApp.close()
  }
})
