import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const instances: Array<{
    destroy: ReturnType<typeof vi.fn>
    emit(event: string): void
    setContextMenu: ReturnType<typeof vi.fn>
    setToolTip: ReturnType<typeof vi.fn>
  }> = []
  const quit = vi.fn()
  const buildFromTemplate = vi.fn((template) => template)
  const resize = vi.fn(() => ({ resized: true }))
  const createFromPath = vi.fn(() => ({ resize }))

  class MockTray {
    destroy = vi.fn()
    setContextMenu = vi.fn()
    setToolTip = vi.fn()
    private handlers = new Map<string, () => void>()

    constructor(_icon: unknown) {
      instances.push(this)
    }

    on(event: string, callback: () => void): this {
      this.handlers.set(event, callback)
      return this
    }

    emit(event: string): void {
      this.handlers.get(event)?.()
    }
  }

  return { buildFromTemplate, createFromPath, instances, MockTray, quit, resize }
})

vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  nativeImage: { createFromPath: mocks.createFromPath },
  Tray: mocks.MockTray
}))

import { RecoveryTray } from '../src/main/recovery-tray'

describe('RecoveryTray', () => {
  beforeEach(() => {
    mocks.instances.splice(0)
    vi.clearAllMocks()
  })

  it('appears only while the floating pet is hidden and restores it on click', () => {
    const actions = {
      showPet: vi.fn(),
      showActivity: vi.fn(),
      showSettings: vi.fn()
    }
    const recovery = new RecoveryTray('/qpet/icon.png', actions)

    recovery.setPetVisible(false)
    expect(mocks.createFromPath).toHaveBeenCalledWith('/qpet/icon.png')
    expect(mocks.resize).toHaveBeenCalledWith({ width: 18, height: 18, quality: 'best' })
    expect(mocks.instances).toHaveLength(1)
    expect(mocks.instances[0].setToolTip).toHaveBeenCalledWith('QPet — floating pet hidden')
    expect(mocks.buildFromTemplate.mock.calls[0][0].map((item: { label?: string }) => item.label))
      .toEqual(['Show Floating Pet', 'Show Activity', 'Settings…', undefined, 'Quit QPet'])

    mocks.instances[0].emit('click')
    expect(actions.showPet).toHaveBeenCalledOnce()

    recovery.setPetVisible(false)
    expect(mocks.instances).toHaveLength(1)
    recovery.setPetVisible(true)
    expect(mocks.instances[0].destroy).toHaveBeenCalledOnce()
  })
})
