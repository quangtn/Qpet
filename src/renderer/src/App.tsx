import { useCallback, useEffect, useState } from 'react'
import { Pet } from './Pet'
import { Settings } from './Settings'
import { Tray } from './Tray'
import { useQPet } from './use-qpet'

export type WindowMode = 'pet' | 'tray' | 'onboarding' | 'settings'

export function getWindowMode(search = window.location.search): WindowMode {
  const requested = new URLSearchParams(search).get('window')?.toLowerCase()
  if (requested === 'pet') return 'pet'
  if (requested === 'onboarding') return 'onboarding'
  if (requested === 'settings' || requested === 'onboarding/settings') return 'settings'
  return 'tray'
}

export function App(): React.JSX.Element {
  const controller = useQPet()
  const [announcement, setAnnouncement] = useState('')
  const mode = getWindowMode()

  const announce = useCallback((message: string) => {
    setAnnouncement(message)
  }, [])

  useEffect(() => {
    if (!announcement) return undefined
    const timeout = window.setTimeout(() => setAnnouncement(''), 3_600)
    return () => window.clearTimeout(timeout)
  }, [announcement])

  if (mode === 'pet') {
    return (
      <Pet
        activities={controller.snapshot.activities}
        loading={controller.loading}
        theme={controller.snapshot.settings.petTheme}
      />
    )
  }

  return (
    <>
      {mode === 'tray' ? (
        <Tray controller={controller} announce={announce} />
      ) : (
        <Settings
          controller={controller}
          onboarding={mode === 'onboarding'}
          announce={announce}
        />
      )}
      <div
        className={`toast ${announcement ? 'is-visible' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </>
  )
}
