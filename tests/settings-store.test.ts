import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/settings-store'

describe('SettingsStore', () => {
  it('uses privacy-friendly operational defaults and persists updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qpet-settings-'))
    const store = new SettingsStore(directory)

    expect(await store.initialize()).toEqual({
      launchAtLogin: true,
      systemNotifications: true,
      soundNotifications: true,
      petVisible: true
    })

    const updated = await store.update({
      systemNotifications: false,
      petPosition: { x: 15.7, y: 21.2 }
    })
    expect(updated).toEqual({
      launchAtLogin: true,
      systemNotifications: false,
      soundNotifications: true,
      petVisible: true,
      petPosition: { x: 16, y: 21 }
    })

    const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    expect(persisted).toEqual(updated)
  })

  it('serializes concurrent updates without dropping either change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qpet-settings-race-'))
    const store = new SettingsStore(directory)
    await store.initialize()

    await Promise.all([
      store.update({ systemNotifications: false }),
      store.update({ petVisible: false })
    ])

    expect(store.get()).toMatchObject({
      launchAtLogin: true,
      systemNotifications: false,
      soundNotifications: true,
      petVisible: false
    })
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))).toEqual(
      store.get()
    )
  })
})
