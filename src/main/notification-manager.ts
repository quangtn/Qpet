import { Notification } from 'electron'
import { spawn } from 'node:child_process'
import { PROVIDER_LABELS, type Activity, type SoundTrigger } from '@shared'

const MACOS_SOUNDS: Readonly<Record<'attention' | 'ready', string>> = {
  attention: '/System/Library/Sounds/Glass.aiff',
  ready: '/System/Library/Sounds/Hero.aiff'
}

/**
 * Sound is intentionally played outside the native Notification API: unsigned
 * macOS Electron builds cannot deliver UNNotification banners, while `afplay`
 * remains a local, dependable attention cue.
 */
export function playMacNotificationSound(trigger: SoundTrigger = 'needs_input'): void {
  if (process.platform !== 'darwin') return
  try {
    const player = spawn('/usr/bin/afplay', [macSoundPath(trigger)], {
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

export function macSoundPath(trigger: SoundTrigger): string {
  return trigger === 'ready' ? MACOS_SOUNDS.ready : MACOS_SOUNDS.attention
}

export class NotificationManager {
  private readonly seen = new Map<string, { signature: string; state: Activity['state'] }>()
  private primed = false

  constructor(
    private readonly enabled: () => boolean,
    private readonly onClick: () => void,
    private readonly soundTriggers: () => readonly SoundTrigger[] = () => [],
    private readonly playSound: (trigger: SoundTrigger) => void = playMacNotificationSound
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
      this.seen.set(activity.id, { signature, state: activity.state })

      const soundTrigger = toSoundTrigger(activity.state)
      if (
        soundTrigger &&
        (soundTrigger === 'ready' || activity.unread) &&
        previous?.state !== activity.state &&
        this.soundTriggers().includes(soundTrigger)
      ) {
        this.playSound(soundTrigger)
      }

      const needsAttention = activity.state === 'needs_input' || activity.state === 'blocked'
      if (previous?.signature === signature || !activity.unread || !needsAttention) {
        continue
      }

      if (!this.enabled() || !Notification.isSupported()) continue

      const title =
        activity.state === 'needs_input'
          ? `${activity.projectName} needs input`
          : `${activity.projectName} is blocked`
      const notification = new Notification({
        title,
        body: `${PROVIDER_LABELS[activity.provider]} · ${activity.summary}`,
        silent: true
      })
      notification.on('click', this.onClick)
      notification.show()
    }
  }

  private remember(activity: Activity): void {
    this.seen.set(activity.id, {
      signature: this.signature(activity),
      state: activity.state
    })
  }

  private signature(activity: Activity): string {
    return `${activity.state}:${activity.updatedAt}`
  }
}

function toSoundTrigger(state: Activity['state']): SoundTrigger | undefined {
  return state === 'needs_input' || state === 'blocked' || state === 'ready'
    ? state
    : undefined
}
