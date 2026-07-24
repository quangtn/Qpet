import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { openProviderApp } from '../src/main/provider-apps'

function opener(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
  child.unref = vi.fn()
  return child
}

describe('openProviderApp', () => {
  beforeEach(() => spawnMock.mockReset())

  it('uses the fixed macOS ChatGPT target for Codex', async () => {
    const child = opener()
    spawnMock.mockReturnValue(child)

    const result = openProviderApp('codex')
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ ok: true, message: 'ChatGPT opened.' })
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', 'ChatGPT'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    )
  })

  it('reports a missing Claude app without running arbitrary commands', async () => {
    const child = opener()
    spawnMock.mockReturnValue(child)

    const result = openProviderApp('claude')
    child.emit('close', 1)

    await expect(result).resolves.toEqual({ ok: false, message: 'Could not find Claude.' })
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', 'Claude'],
      expect.any(Object)
    )
  })

  it('uses the fixed Cursor application target', async () => {
    const child = opener()
    spawnMock.mockReturnValue(child)

    const result = openProviderApp('cursor')
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ ok: true, message: 'Cursor opened.' })
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', 'Cursor'],
      expect.any(Object)
    )
  })

  it('uses the fixed Hermes application target', async () => {
    const child = opener()
    spawnMock.mockReturnValue(child)

    const result = openProviderApp('hermes')
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ ok: true, message: 'Hermes opened.' })
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', 'Hermes'],
      expect.any(Object)
    )
  })

  it('opens only a validated loopback ClaudeClaw dashboard', async () => {
    const openExternal = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => '')
    await expect(openProviderApp('claudeclaw', {
      preferredClaudeClaw: async () => ({
        root: '/Users/test/claw',
        running: true,
        webUrl: 'http://127.0.0.1:4632'
      }),
      openExternal,
      openPath
    })).resolves.toEqual({ ok: true, message: 'ClaudeClaw dashboard opened.' })
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:4632')
    expect(spawnMock).not.toHaveBeenCalled()

    await openProviderApp('claudeclaw', {
      preferredClaudeClaw: async () => ({
        root: '/Users/test/claw',
        running: true,
        webUrl: 'https://attacker.example/?token=secret'
      }),
      openExternal,
      openPath
    })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenCalledWith('/Users/test/claw')
  })
})
