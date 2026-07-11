import { Notification } from 'electron'
import { spawn } from 'node:child_process'
import type { Activity } from '@shared'

const MACOS_ALERT_SOUND = '/System/Library/Sounds/Glass.aiff'

/**
 * Sound is intentionally played outside the native Notification API: unsigned
 * macOS Electron builds cannot deliver UNNotification banners, while `afplay`
 * remains a local, dependable attention cue.
 */
export function playMacNotificationSound(): void {
  if (process.platform !== 'darwin') return
  try {
    const player = spawn('/usr/bin/afplay', [MACOS_ALERT_SOUND], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    player.once('error', () => undefined)
    player.unref()
  } catch {
    // Audio is optional and must never interrupt agent hook processing.
  }
}

export class NotificationManager {
  private readonly seen = new Map<string, string>()
  private primed = false

  constructor(
    private readonly enabled: () => boolean,
    private readonly onClick: () => void,
    private readonly soundEnabled: () => boolean = () => false,
    private readonly playSound: () => void = playMacNotificationSound
  ) {}

  handle(activities: Activity[]): void {
    if (!this.primed) {
      for (const activity of activities) this.remember(activity)
      this.primed = true
      return
    }

    const currentIds = new Set(activities.map((activity) => activity.id))
    for (const id of this.seen.keys()) {
      if (!currentIds.has(id)) this.seen.delete(id)
    }

    for (const activity of activities) {
      const signature = this.signature(activity)
      const previous = this.seen.get(activity.id)
      this.seen.set(activity.id, signature)

      const needsAttention = activity.state === 'needs_input' || activity.state === 'blocked'
      if (previous === signature || !activity.unread || !needsAttention) {
        continue
      }

      if (this.soundEnabled()) this.playSound()

      if (!this.enabled() || !Notification.isSupported()) continue

      const title =
        activity.state === 'needs_input'
          ? `${activity.projectName} needs input`
          : `${activity.projectName} is blocked`
      const provider = activity.provider === 'codex'
        ? 'Codex'
        : activity.provider === 'claude'
          ? 'Claude Code'
          : 'Cursor'
      const notification = new Notification({
        title,
        body: `${provider} · ${activity.summary}`,
        silent: true
      })
      notification.on('click', this.onClick)
      notification.show()
    }
  }

  private remember(activity: Activity): void {
    this.seen.set(activity.id, this.signature(activity))
  }

  private signature(activity: Activity): string {
    return `${activity.state}:${activity.updatedAt}`
  }
}
