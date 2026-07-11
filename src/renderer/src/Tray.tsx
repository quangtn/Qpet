import { useMemo, useState } from 'react'
import type { Activity, AppSnapshot, SessionAction } from '@shared'
import { Icon } from './icons'
import {
  formatRelativeTime,
  getPetMood,
  healthLabels,
  sessionActions,
  sortActivities,
  stateDescriptions,
  stateLabels
} from './model'
import type { QPetController } from './use-qpet'

const actionLabels: Record<SessionAction, string> = {
  attach: 'Attach',
  resume: 'Resume',
  open_project: 'Open',
  copy_command: 'Copy command'
}

const actionIcons: Record<SessionAction, 'terminal' | 'arrow' | 'folder' | 'copy'> = {
  attach: 'terminal',
  resume: 'arrow',
  open_project: 'folder',
  copy_command: 'copy'
}

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
  const mood = getPetMood(activities)
  const liveCount = activities.filter((activity) => activity.live).length
  const attentionCount = activities.filter(
    (activity) => activity.state === 'needs_input' || activity.state === 'blocked'
  ).length

  return (
    <main className="tray-shell" data-testid="activity-tray">
      <header className="tray-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <img src="./pet/glasses-pet-master-256.png" alt="" />
          </span>
          <span>
            <strong>QPet</strong>
            <small>
              {attentionCount
                ? `${attentionCount} need${attentionCount === 1 ? 's' : ''} you`
                : liveCount
                  ? `${liveCount} active`
                  : 'Companion is resting'}
            </small>
          </span>
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

      <section className={`status-banner state-${mood}`} aria-label="Current QPet status">
        <span className="status-orb" aria-hidden="true">
          <i />
        </span>
        <span>
          <strong>{stateLabels[mood]}</strong>
          <small>{stateDescriptions[mood]}</small>
        </span>
        {liveCount > 0 ? <em>{liveCount} live</em> : null}
      </section>

      {error ? (
        <div className="inline-notice is-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void controller.reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="activity-region" aria-labelledby="activity-heading">
        <div className="section-heading">
          <h1 id="activity-heading">Activity</h1>
          {activities.length ? <span>{activities.length}</span> : null}
        </div>

        {loading ? (
          <ActivitySkeleton />
        ) : activities.length ? (
          <div className="activity-list">
            {activities.map((activity) => (
              <ActivityCard
                key={activity.id}
                activity={activity}
                controller={controller}
                announce={announce}
              />
            ))}
          </div>
        ) : (
          <EmptyActivity />
        )}
      </section>

      <IntegrationFooter snapshot={snapshot} />
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
      <div className="activity-card-head">
        <div className="activity-title">
          <ProviderBadge provider={activity.provider} />
          <span>
            <strong title={activity.projectName}>{activity.projectName}</strong>
            <small>
              <span className={`state-dot state-${activity.state}`} aria-hidden="true" />
              {stateLabels[activity.state]}
              <span aria-hidden="true">·</span>
              <time dateTime={new Date(activity.updatedAt).toISOString()}>
                {formatRelativeTime(activity.updatedAt)}
              </time>
            </small>
          </span>
        </div>
        <div className="card-meta-actions">
          {activity.unread ? <span className="unread-dot" title="Unread" /> : null}
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
      </div>
      <p>{activity.summary}</p>
      <div className="activity-actions" aria-label={`Actions for ${activity.projectName}`}>
        {actions.map((action, index) => (
          <button
            key={action}
            className={index === 0 ? 'action-button primary' : 'action-button'}
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void runAction(action)}
          >
            <Icon name={actionIcons[action]} />
            <span>{busyAction === action ? 'Working…' : actionLabels[action]}</span>
          </button>
        ))}
      </div>
    </article>
  )
}

function ProviderBadge({ provider }: { provider: Activity['provider'] }): React.JSX.Element {
  const name = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Cursor'
  return (
    <span className={`provider-badge provider-${provider}`} aria-label={name}>
      <img src={`./providers/${provider}.png`} alt="" />
    </span>
  )
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

function EmptyActivity(): React.JSX.Element {
  return (
    <div className="empty-activity">
      <span className="empty-pet" aria-hidden="true">
        <img src="./pet/glasses-pet-master-256.png" alt="" />
        <i>z</i>
      </span>
      <strong>All quiet</strong>
      <p>Start a Codex, Claude Code, or Cursor session. QPet will keep watch.</p>
    </div>
  )
}

function IntegrationFooter({ snapshot }: { snapshot: AppSnapshot }): React.JSX.Element {
  const { integrations } = snapshot
  return (
    <footer className="integration-footer">
      <div className="integration-pills" aria-label="Integration health">
        {[integrations.codex, integrations.claude, integrations.cursor].map((integration) => (
          <span
            key={integration.provider}
            className={`health-pill health-${integration.health}`}
            title={`${integration.provider === 'codex' ? 'Codex' : integration.provider === 'claude' ? 'Claude Code' : 'Cursor'}: ${healthLabels[integration.health]}`}
          >
            <i aria-hidden="true" />
            {integration.provider === 'codex' ? 'Codex' : integration.provider === 'claude' ? 'Claude' : 'Cursor'}
          </span>
        ))}
      </div>
      <button type="button" onClick={() => void window.qpet.showSettings()}>
        Manage
        <Icon name="chevron" />
      </button>
    </footer>
  )
}
