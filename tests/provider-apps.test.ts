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
})
