import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PROVIDER_SHORT_LABELS,
  type Activity,
  type AppSnapshot,
  type SessionAction
} from '@shared'
import { Icon } from './icons'
import {
  formatRelativeTime,
  sessionActions,
  sortActivities,
  stateLabels
} from './model'
import type { QPetController } from './use-qpet'
import { petBrandImage } from './pet-themes'

const actionLabels: Record<SessionAction, string> = {
  attach: 'Attach',
  resume: 'Resume',
  open_project: 'Open',
  open_provider: 'Dashboard',
  copy_command: 'Copy command'
}

const actionIcons: Record<SessionAction, 'terminal' | 'arrow' | 'open' | 'copy'> = {
  attach: 'terminal',
  resume: 'arrow',
  open_project: 'open',
  open_provider: 'open',
  copy_command: 'copy'
}

const PAGE_SIZE = 12

interface TrayProps {
  controller: QPetController
  announce(message: string): void
}

export function Tray({ controller, announce }: TrayProps): React.JSX.Element {
  const { snapshot, loading, error } = controller
  const activities = useMemo(
    () => sortActivities(snapshot.activities),
    [snapshot.activities]
  )
  const [pageIndex, setPageIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const previousAttentionRevision = useRef<string | undefined>(undefined)
  const pageCount = Math.max(1, Math.ceil(activities.length / PAGE_SIZE))
  const pageActivities = activities.slice(
    pageIndex * PAGE_SIZE,
    (pageIndex + 1) * PAGE_SIZE
  )
  const attentionRevision = activities
    .filter((activity) => activity.state === 'needs_input' || activity.state === 'blocked')
    .map((activity) => `${activity.id}:${activity.state}:${activity.updatedAt}`)
    .join('|')

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1))
  }, [pageCount])

  useEffect(() => {
    if (
      previousAttentionRevision.current !== undefined &&
      previousAttentionRevision.current !== attentionRevision
    ) {
      setPageIndex(0)
    }
    previousAttentionRevision.current = attentionRevision
  }, [attentionRevision])

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [pageIndex])

  return (
    <main className="tray-shell" data-testid="activity-tray">
      <header className="activity-tray-header">
        <div className="activity-heading">
          <h1 id="activity-heading">Activity</h1>
          {activities.length ? <span>{activities.length}</span> : null}
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Open settings"
            title="Settings"
            onClick={() => void window.qpet.showSettings()}
          >
            <Icon name="gear" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Close activity tray"
            title="Close"
            onClick={() => void window.qpet.hideTray()}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      {error ? (
        <div className="inline-notice is-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void controller.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="activity-region" aria-labelledby="activity-heading">
        {loading ? (
          <ActivitySkeleton />
        ) : activities.length ? (
          <div className="activity-list" ref={listRef}>
            {pageActivities.map((activity) => (
              <ActivityCard
                key={activity.id}
                activity={activity}
                controller={controller}
                announce={announce}
              />
            ))}
          </div>
        ) : (
          <EmptyActivity theme={snapshot.settings.petTheme} />
        )}
      </section>
      {activities.length > PAGE_SIZE ? (
        <nav className="activity-pagination" aria-label="Activity pages">
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          >
            Previous
          </button>
          <span>Page {pageIndex + 1} of {pageCount}</span>
          <button
            className="next"
            type="button"
            disabled={pageIndex >= pageCount - 1}
            onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
          >
            Next
          </button>
        </nav>
      ) : null}
    </main>
  )
}

function ActivityCard({
  activity,
  controller,
  announce
}: {
  activity: Activity
  controller: QPetController
  announce(message: string): void
}): React.JSX.Element {
  const [busyAction, setBusyAction] = useState<SessionAction>()
  const actions = sessionActions(activity)

  const runAction = async (action: SessionAction): Promise<void> => {
    setBusyAction(action)
    try {
      const result = await controller.performAction({ activityId: activity.id, action })
      announce(result.message || (result.ok ? `${actionLabels[action]} complete.` : 'Action failed.'))
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : 'That action could not be completed.')
    } finally {
      setBusyAction(undefined)
    }
  }

  return (
    <article
      className={`activity-card state-${activity.state}`}
      data-testid="activity-card"
      data-state={activity.state}
      data-provider={activity.provider}
    >
      <div className="activity-accent" aria-hidden="true" />
      <div className="activity-title">
        <ProviderBadge provider={activity.provider} />
        <span>
          <strong title={activity.projectName}>{activity.projectName}</strong>
          <small>
            <span className={`state-dot state-${activity.state}`} aria-hidden="true" />
            {providerName(activity.provider)}
            <span aria-hidden="true">·</span>
            {stateLabels[activity.state]}
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(activity.updatedAt).toISOString()}>
              {formatRelativeTime(activity.updatedAt)}
            </time>
          </small>
        </span>
      </div>
      <div className="activity-row-actions" aria-label={`Actions for ${activity.projectName}`}>
        {actions.map((action) => {
          const primary = action === 'resume' || action === 'attach' || action === 'open_provider'
          return (
            <button
              key={action}
              className={`action-button ${primary ? 'primary' : 'icon-only'}`}
              type="button"
              disabled={Boolean(busyAction)}
              aria-label={`${actionLabels[action]} ${activity.projectName}`}
              title={actionLabels[action]}
              onClick={() => void runAction(action)}
            >
              <Icon name={actionIcons[action]} />
              {primary ? <span>{busyAction === action ? 'Working…' : actionLabels[action]}</span> : null}
            </button>
          )
        })}
          <button
            className="dismiss-button"
            type="button"
            aria-label={`Dismiss ${activity.projectName}`}
            title="Dismiss"
            onClick={() => void controller.dismiss(activity.id)}
          >
            <Icon name="close" />
          </button>
      </div>
    </article>
  )
}

function ProviderBadge({ provider }: { provider: Activity['provider'] }): React.JSX.Element {
  return (
    <span className={`provider-badge provider-${provider}`} aria-label={providerName(provider)}>
      <img src={`./providers/${provider}.png`} alt="" />
    </span>
  )
}

function providerName(provider: Activity['provider']): string {
  return PROVIDER_SHORT_LABELS[provider]
}

function ActivitySkeleton(): React.JSX.Element {
  return (
    <div className="activity-skeleton" aria-label="Loading activity">
      <i />
      <span>
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

function EmptyActivity({ theme }: { theme: AppSnapshot['settings']['petTheme'] }): React.JSX.Element {
  return (
    <div className="empty-activity">
      <span className="empty-pet" aria-hidden="true">
        <img className={`theme-${theme}`} src={petBrandImage(theme)} alt="" />
        <i>z</i>
      </span>
      <strong>All quiet</strong>
      <p>Start a supported agent session. QPet will keep watch.</p>
    </div>
  )
}
