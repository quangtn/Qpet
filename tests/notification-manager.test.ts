import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Activity } from '../src/shared/contracts'

const notificationSpies = vi.hoisted(() => ({
  created: [] as Array<{ title?: string; body?: string }>,
  shown: vi.fn(),
  clickHandlers: [] as Array<() => void>
}))

vi.mock('electron', () => ({
  Notification: class MockNotification {
    static isSupported(): boolean {
      return true
    }

    constructor(options: { title?: string; body?: string }) {
      notificationSpies.created.push(options)
    }

    on(event: string, callback: () => void): void {
      if (event === 'click') notificationSpies.clickHandlers.push(callback)
    }

    show(): void {
      notificationSpies.shown()
    }
  }
}))

import { NotificationManager } from '../src/main/notification-manager'

function activity(patch: Partial<Activity> = {}): Activity {
  return {
    id: 'claude:one',
    provider: 'claude',
    sessionId: 'one',
    cwd: '/tmp/project',
    projectName: 'project',
    state: 'running',
    summary: 'Claude is working',
    updatedAt: 1,
    unread: false,
    live: true,
    ...patch
  }
}

describe('NotificationManager', () => {
  beforeEach(() => {
    notificationSpies.created.length = 0
    notificationSpies.clickHandlers.length = 0
  })

  it('notifies only unread needs-input and blocked transitions', () => {
    const onClick = vi.fn()
    const manager = new NotificationManager(() => true, onClick)
    manager.handle([])

    manager.handle([activity()])
    manager.handle([
      activity({
        state: 'needs_input',
        summary: 'Claude needs approval',
        unread: true,
        updatedAt: 2
      })
    ])
    manager.handle([
      activity({
        state: 'needs_input',
        summary: 'Claude needs approval',
        unread: true,
        updatedAt: 2
      })
    ])
    manager.handle([
      activity({ state: 'ready', summary: 'Claude finished', unread: true, updatedAt: 3 })
    ])
    manager.handle([
      activity({
        state: 'blocked',
        summary: 'Claude could not finish',
        unread: true,
        updatedAt: 4
      })
    ])
    manager.handle([
      activity({
        state: 'blocked',
        summary: 'Claude could not finish',
        unread: false,
        updatedAt: 5
      })
    ])

    expect(notificationSpies.shown).toHaveBeenCalledTimes(2)
    expect(notificationSpies.created).toEqual([
      {
        title: 'project needs input',
        body: 'Claude Code · Claude needs approval',
        silent: true
      },
      {
        title: 'project is blocked',
        body: 'Claude Code · Claude could not finish',
        silent: true
      }
    ])

    notificationSpies.clickHandlers[0]?.()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('stays silent when notifications are disabled', () => {
    const manager = new NotificationManager(() => false, vi.fn())
    manager.handle([])
    manager.handle([
      activity({
        state: 'needs_input',
        summary: 'Claude needs input',
        unread: true,
        updatedAt: 2
      })
    ])

    expect(notificationSpies.shown).not.toHaveBeenCalled()
  })

  it('plays a local sound for attention transitions even without native banners', () => {
    const playSound = vi.fn()
    const manager = new NotificationManager(() => false, vi.fn(), () => true, playSound)
    manager.handle([])
    manager.handle([
      activity({
        state: 'needs_input',
        summary: 'Claude needs input',
        unread: true,
        updatedAt: 2
      })
    ])
    manager.handle([
      activity({
        state: 'needs_input',
        summary: 'Claude needs input',
        unread: true,
        updatedAt: 2
      })
    ])

    expect(playSound).toHaveBeenCalledTimes(1)
    expect(notificationSpies.shown).not.toHaveBeenCalled()
  })
})
