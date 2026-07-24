import { useRef, useState, type PointerEvent } from 'react'
import {
  PROVIDERS,
  PROVIDER_SHORT_LABELS,
  type Activity,
  type DictationStatus,
  type PetTheme
} from '@shared'
import { getPetMood, stateDescriptions, stateLabels, type PetMood } from './model'
import { petStateImage } from './pet-themes'

const moodGlyphs: Record<PetMood, string> = {
  sleeping: 'z',
  running: '',
  needs_input: '!',
  ready: '✓',
  blocked: '×'
}

interface ProviderSummary {
  count: number
  label: 'working' | 'needs-input' | 'blocked' | 'ready'
}

const providerStatusLabels: Record<ProviderSummary['label'], string> = {
  working: 'Working',
  'needs-input': 'Needs input',
  blocked: 'Blocked',
  ready: 'Ready'
}

function summarizeProvider(activities: Activity[]): ProviderSummary | null {
  const countByState = (state: Activity['state'], liveOnly = false): number =>
    activities.filter((activity) => activity.state === state && (!liveOnly || activity.live)).length

  const input = countByState('needs_input', true)
  if (input > 0) return { count: input, label: 'needs-input' }
  const blocked = countByState('blocked', true)
  if (blocked > 0) return { count: blocked, label: 'blocked' }
  const working = countByState('running', true)
  if (working > 0) return { count: working, label: 'working' }
  const ready = activities.filter((activity) => activity.state === 'ready' && activity.unread).length
  if (ready > 0) return { count: ready, label: 'ready' }
  return null
}

interface PetProps {
  activities: Activity[]
  loading: boolean
  theme: PetTheme
  dictation: DictationStatus
}

export function Pet({ activities, loading, theme, dictation }: PetProps): React.JSX.Element {
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  const activityMood = loading ? 'sleeping' : getPetMood(activities)
  const dictationActive = dictation.state !== 'idle'
  const mood: PetMood = dictation.state === 'listening' || dictation.state === 'transcribing'
    ? 'running'
    : dictation.state === 'copied' || dictation.state === 'reviewing'
      ? 'ready'
      : dictation.state === 'error'
        ? 'blocked'
        : activityMood
  const dictationLabel = dictation.state === 'listening'
    ? 'Listening'
    : dictation.state === 'transcribing'
      ? 'Transcribing'
      : dictation.state === 'copied'
        ? 'Copied'
        : dictation.state === 'reviewing'
          ? 'Review text'
          : dictation.state === 'error'
            ? 'Dictation error'
            : undefined
  const attentionCount = activities.filter(
    (activity) =>
      activity.live && (activity.state === 'needs_input' || activity.state === 'blocked')
  ).length
  const providerSummaries = PROVIDERS.flatMap((provider) => {
    const summary = summarizeProvider(activities.filter((activity) => activity.provider === provider))
    return summary ? [{ provider, ...summary }] : []
  })
  const ariaLabel = dictationLabel
    ? `${dictationLabel}. ${dictation.message ?? 'Use the dictation shortcut to continue.'}`
    : `${stateLabels[mood]}. ${stateDescriptions[mood]}. Open QPet activity.`

  const endDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    const wasDragged = drag.current.moved
    drag.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The window can move between displays before the capture is released.
    }
    void window.qpet.endPetDrag()
    if (wasDragged) {
      suppressClick.current = true
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
  }

  const beginDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    drag.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: false
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an enhancement; IPC dragging still works without it.
    }
    void window.qpet.beginPetDrag({ x: event.screenX, y: event.screenY })
  }

  const moveDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    if (!drag.current.moved) {
      const distance = Math.hypot(event.screenX - drag.current.startX, event.screenY - drag.current.startY)
      if (distance < 4) return
      drag.current.moved = true
      setDragging(true)
    }
    void window.qpet.movePetDrag({ x: event.screenX, y: event.screenY })
  }

  return (
    <main className="pet-window" data-testid="pet-window" data-state={mood} data-theme={theme} data-dictation={dictation.state}>
      <button
        className="pet-button"
        data-testid="pet"
        data-state={mood}
        data-dragging={dragging ? 'true' : 'false'}
        type="button"
        aria-label={ariaLabel}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(event) => {
          if (suppressClick.current) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          void window.qpet.toggleTray()
        }}
      >
        <span className="pet-aura" aria-hidden="true" />
        <span className="motion-lines" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <img
          className={`pet-sprite theme-${theme}`}
          src={petStateImage(theme, mood)}
          draggable="false"
          alt=""
        />
        <span className="sleep-signs" aria-hidden="true">
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
        <span className="ready-stars" aria-hidden="true">
          <i>✦</i>
          <i>✦</i>
        </span>
        <span className="blocked-bolt" aria-hidden="true">⌁</span>
        <span className="pet-state-badge" aria-hidden="true">
          {mood === 'running' ? <span className="working-clock" /> : moodGlyphs[mood]}
          {attentionCount > 1 && mood === 'needs_input' ? (
            <small>{Math.min(attentionCount, 9)}</small>
          ) : null}
        </span>
        {dictationLabel ? (
          <span className={`dictation-state-label state-${dictation.state}`} role="status">
            {dictationLabel}
          </span>
        ) : null}
      </button>
      {!dictationActive && providerSummaries.length > 0 ? (
        <aside
          className="provider-statuses"
          data-count={providerSummaries.length}
          aria-label="Open provider desktop apps"
        >
          {providerSummaries.map(({ provider, count, label }) => (
            <button
              key={provider}
              className={`provider-status provider-status-${provider}`}
              data-testid={`provider-status-${provider}`}
              data-state={label}
              type="button"
              aria-label={
                provider === 'claudeclaw'
                  ? 'Open ClaudeClaw dashboard'
                  : `Open ${PROVIDER_SHORT_LABELS[provider]} Desktop`
              }
              title={
                provider === 'claudeclaw'
                  ? 'Open ClaudeClaw dashboard'
                  : `Open ${PROVIDER_SHORT_LABELS[provider]} Desktop`
              }
              onClick={(event) => {
                event.stopPropagation()
                void window.qpet.openProviderApp(provider)
              }}
            >
              <small>{PROVIDER_SHORT_LABELS[provider]}</small>
              <strong>{count} {providerStatusLabels[label]}</strong>
            </button>
          ))}
        </aside>
      ) : null}
    </main>
  )
}
