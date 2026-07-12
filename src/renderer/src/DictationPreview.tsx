import { useEffect, useState } from 'react'
import { Icon } from './icons'
import type { QPetController } from './use-qpet'

export function DictationPreview({ controller }: { controller: QPetController }): React.JSX.Element {
  const preview = controller.snapshot.dictation.preview ?? ''
  const state = controller.snapshot.dictation.state
  const reviewing = state === 'reviewing'
  const failed = state === 'error'
  const [draft, setDraft] = useState(preview)
  useEffect(() => setDraft(preview), [preview])
  const heading = failed
    ? 'Dictation unavailable'
    : reviewing
    ? 'Ready to paste'
    : state === 'transcribing'
      ? 'Finishing transcription…'
      : 'Listening…'
  return (
    <main className="dictation-preview" data-testid="dictation-preview">
      <header>
        <span>
          <strong>{heading}</strong>
          <small>
            {failed
              ? controller.snapshot.dictation.message ?? 'Dictation could not continue.'
              : reviewing
                ? 'Review the transcription before copying.'
                : 'Live preview — nothing is copied yet.'}
          </small>
        </span>
        <button
          type="button"
          aria-label="Dismiss transcription"
          title="Dismiss"
          onClick={() => void window.qpet.performDictationAction('cancel')}
        >
          <Icon name="close" />
        </button>
      </header>
      {failed ? (
        <p className="dictation-error-message" role="alert">
          Check Microphone and Speech Recognition access in System Settings, then try again.
        </p>
      ) : (
        <textarea
          className="dictation-preview-text"
          aria-label="Transcription text"
          readOnly={!reviewing}
          value={draft}
          placeholder={state === 'transcribing' ? 'Finishing…' : 'Listening for speech…'}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      )}
      <footer>
        <button
          className="quiet-button"
          type="button"
          onClick={() => void window.qpet.performDictationAction('retry')}
        >
          <Icon name="refresh" />
          Try again
        </button>
        {failed ? null : reviewing ? (
          <button
            className="primary-button"
            type="button"
            disabled={!draft.trim()}
            onClick={() => void window.qpet.performDictationAction('copy', draft)}
          >
            <Icon name="copy" />
            Copy
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            disabled={state === 'transcribing'}
            onClick={() => void window.qpet.toggleDictation()}
          >
            <Icon name="check" />
            {state === 'transcribing' ? 'Finishing…' : 'Stop & review'}
          </button>
        )}
      </footer>
    </main>
  )
}
