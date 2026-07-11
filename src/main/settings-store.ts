import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared'

const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: true,
  systemNotifications: true,
  soundNotifications: true,
  petVisible: true,
  petTheme: 'classic'
}

export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'settings.json')
  }

  async initialize(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = this.normalize({ ...DEFAULT_SETTINGS, ...parsed })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Unable to load QPet settings; defaults will be used.', error)
      }
    }

    return this.get()
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const operation = this.operationQueue.then(async () => {
      this.settings = this.normalize({ ...this.settings, ...patch })
      await this.persist()
      return this.get()
    })
    this.operationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private normalize(candidate: AppSettings): AppSettings {
    const petPosition = candidate.petPosition
    return {
      launchAtLogin: candidate.launchAtLogin !== false,
      systemNotifications: candidate.systemNotifications !== false,
      soundNotifications: candidate.soundNotifications !== false,
      petVisible: candidate.petVisible !== false,
      petTheme: candidate.petTheme === 'qmini' ? 'qmini' : 'classic',
      ...(petPosition && Number.isFinite(petPosition.x) && Number.isFinite(petPosition.y)
        ? { petPosition: { x: Math.round(petPosition.x), y: Math.round(petPosition.y) } }
        : {})
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(this.settings, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
