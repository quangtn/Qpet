import { useState } from 'react'
import type { AppSettings, IntegrationDetail, PetTheme, Provider } from '@shared'
import { Icon } from './icons'
import { healthLabels } from './model'
import type { QPetController } from './use-qpet'
import { petBrandImage, petThemes } from './pet-themes'

interface SettingsProps {
  controller: QPetController
  onboarding?: boolean
  announce(message: string): void
}

export function Settings({
  controller,
  onboarding = false,
  announce
}: SettingsProps): React.JSX.Element {
  const { snapshot, loading, error } = controller
  const [busy, setBusy] = useState<'install' | 'uninstall' | 'refresh' | 'sound'>()
  const [setupComplete, setSetupComplete] = useState(false)
  const installed =
    snapshot.integrations.codex.installed ||
    snapshot.integrations.claude.installed ||
    snapshot.integrations.cursor.installed

  const install = async (): Promise<void> => {
    setBusy('install')
    try {
      const result = await controller.install()
      if (result.ok) {
        await controller.updateSettings({ launchAtLogin: true })
        setSetupComplete(true)
      }
      announce(result.message)
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : 'Integrations could not be installed.')
    } finally {
      setBusy(undefined)
    }
  }

  const uninstall = async (): Promise<void> => {
    setBusy('uninstall')
    try {
      const result = await controller.uninstall()
      announce(result.message)
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : 'Integrations could not be removed.')
    } finally {
      setBusy(undefined)
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy('refresh')
    try {
      await controller.refreshIntegrations()
      announce('Integration status refreshed.')
    } catch (cause) {
      announce(cause instanceof Error ? cause.message : 'Integration status could not be refreshed.')
    } finally {
      setBusy(undefined)
    }
  }

  if (onboarding) {
    return (
      <main className="settings-shell onboarding-shell" data-testid="onboarding-window">
        <div className="onboarding-hero">
          <span className="onboarding-pet" aria-hidden="true">
            <span className="onboarding-aura" />
            <img className={`theme-${snapshot.settings.petTheme}`} src={petBrandImage(snapshot.settings.petTheme)} alt="" />
            <i>✦</i>
          </span>
          <p className="eyebrow">Your local coding companion</p>
          <h1>Meet QPet</h1>
          <p>
            QPet watches Codex, Claude Code, and Cursor, then gives you a quiet nudge when a
            session needs attention.
          </p>
        </div>

        <div className="onboarding-features" aria-label="QPet features">
          <Feature icon="bell" title="Only useful alerts" description="Input requests and blockers, without the noise." />
          <Feature icon="sparkle" title="One place to look" description="Live work and completed sessions, ordered by priority." />
          <Feature icon="link" title="Private by design" description="Prompts, commands, and transcripts never enter QPet." />
        </div>

        <section className="setup-card" aria-labelledby="setup-heading">
          <div className="setup-card-head">
            <span>
              <h2 id="setup-heading">Connect your agents</h2>
              <p>QPet adds user-level hooks and keeps your other settings intact.</p>
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh agent detection"
              title="Refresh"
              disabled={Boolean(busy)}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" className={busy === 'refresh' ? 'is-spinning' : ''} />
            </button>
          </div>
          <IntegrationRows
            codex={snapshot.integrations.codex}
            claude={snapshot.integrations.claude}
            cursor={snapshot.integrations.cursor}
            loading={loading}
          />
          {!snapshot.integrations.listenerActive ? (
            <p className="setup-error" role="alert">
              {snapshot.integrations.listenerMessage ??
                'QPet’s local event listener is not running. Restart QPet, then try again.'}
            </p>
          ) : null}
          {error ? <p className="setup-error" role="alert">{error}</p> : null}
        </section>

        <div className="onboarding-actions">
          {setupComplete ? (
            <button className="primary-button" type="button" onClick={() => window.close()}>
              <Icon name="check" />
              QPet is ready
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void install()}
            >
              <Icon name="power" />
              {busy === 'install' ? 'Connecting…' : 'Connect and start QPet'}
            </button>
          )}
          <small>You can remove QPet’s hooks at any time in Settings.</small>
        </div>
      </main>
    )
  }

  return (
    <main className="settings-shell" data-testid="settings-window">
      <header className="settings-header">
        <div>
          <p className="eyebrow">QPet</p>
          <h1>Settings</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close settings"
          title="Close"
          onClick={() => window.close()}
        >
          <Icon name="close" />
        </button>
      </header>

      <section className="settings-section" aria-labelledby="general-heading">
        <div className="settings-section-title">
          <h2 id="general-heading">General</h2>
        </div>
        <div className="settings-group">
          <PetThemePicker
            value={snapshot.settings.petTheme}
            onChange={(petTheme) => controller.updateSettings({ petTheme })}
          />
          <SettingToggle
            title="Launch at login"
            description="Keep QPet ready after you sign in."
            checked={snapshot.settings.launchAtLogin}
            onChange={(launchAtLogin) => controller.updateSettings({ launchAtLogin })}
          />
          <SettingToggle
            title="System notifications"
            description="Alert only for input requests and blockers."
            checked={snapshot.settings.systemNotifications}
            onChange={(systemNotifications) =>
              controller.updateSettings({ systemNotifications })
            }
          />
          <SettingToggle
            title="Notification sounds"
            description="Play a macOS sound for input requests and blockers."
            checked={snapshot.settings.soundNotifications}
            onChange={(soundNotifications) =>
              controller.updateSettings({ soundNotifications })
            }
          />
          <div className="setting-row setting-action-row">
            <label id="test-notification-sound-label">
              <strong>Sound check</strong>
              <small>Play the same alert QPet uses for attention requests.</small>
            </label>
            <button
              className="quiet-button"
              type="button"
              disabled={busy === 'sound'}
              aria-labelledby="test-notification-sound-label"
              onClick={() => {
                setBusy('sound')
                void window.qpet.playTestSound().finally(() => setBusy(undefined))
              }}
            >
              <Icon name="bell" />
              {busy === 'sound' ? 'Playing…' : 'Test sound'}
            </button>
          </div>
          <SettingToggle
            title="Show floating pet"
            description="Hide the pet while keeping a QPet recovery icon in the menu bar."
            checked={snapshot.settings.petVisible}
            onChange={(petVisible) => controller.updateSettings({ petVisible })}
          />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="integrations-heading">
        <div className="settings-section-title with-action">
          <span>
            <h2 id="integrations-heading">Integrations</h2>
            <p>Local hooks send lifecycle events to QPet.</p>
          </span>
          <button
            className="quiet-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" className={busy === 'refresh' ? 'is-spinning' : ''} />
            Refresh
          </button>
        </div>

        <div className="integration-cards">
          <IntegrationCard detail={snapshot.integrations.codex} />
          <IntegrationCard detail={snapshot.integrations.claude} />
          <IntegrationCard detail={snapshot.integrations.cursor} />
        </div>

        {!snapshot.integrations.listenerActive ? (
          <div className="trust-notice listener-notice" role="alert">
            <span>!</span>
            <p>
              {snapshot.integrations.listenerMessage ??
                'QPet’s local event listener is not running. Restart QPet, then use Refresh.'}
            </p>
          </div>
        ) : null}

        {snapshot.integrations.codex.health === 'awaiting_trust' ? (
          <div className="trust-notice" role="status">
            <span>!</span>
            <p>
              Codex hooks are installed. In a new Codex CLI session, trust QPet in
              <code>/hooks</code> if prompted, then send one prompt while QPet is running.
            </p>
          </div>
        ) : null}

        {error ? <p className="setup-error" role="alert">{error}</p> : null}

        <div className="integration-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void install()}
          >
            <Icon name="link" />
            {busy === 'install' ? 'Installing…' : installed ? 'Repair hooks' : 'Install hooks'}
          </button>
          {installed ? (
            <button
              className="danger-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void uninstall()}
            >
              {busy === 'uninstall' ? 'Removing…' : 'Remove QPet hooks'}
            </button>
          ) : null}
        </div>
      </section>

      <section className="privacy-card" aria-label="Privacy">
        <span><Icon name="check" /></span>
        <p>
          <strong>Private by design</strong>
          QPet stores project paths, provider session identifiers, timestamps, and generic
          statuses—not prompts, commands, responses, or transcripts.
        </p>
      </section>

      <footer className="settings-footer">
        <span>QPet {snapshot.appVersion}</span>
        <button type="button" onClick={() => void window.qpet.quit()}>Quit QPet</button>
      </footer>
    </main>
  )
}

function PetThemePicker({
  value,
  onChange
}: {
  value: PetTheme
  onChange(value: PetTheme): Promise<AppSettings>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="pet-theme-setting">
      <span>
        <strong>Pet style</strong>
        <small>Choose the companion that appears across QPet.</small>
      </span>
      <div className="pet-theme-options" role="radiogroup" aria-label="Pet style">
        {petThemes.map((theme) => (
          <button
            key={theme.id}
            className="pet-theme-option"
            type="button"
            role="radio"
            aria-checked={value === theme.id}
            disabled={busy}
            onClick={() => {
              if (theme.id === value) return
              setBusy(true)
              void onChange(theme.id).finally(() => setBusy(false))
            }}
          >
            <img className={`theme-${theme.id}`} src={theme.brandImage} alt="" />
            <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Feature({
  icon,
  title,
  description
}: {
  icon: 'bell' | 'sparkle' | 'link'
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="onboarding-feature">
      <span aria-hidden="true"><Icon name={icon} /></span>
      <p><strong>{title}</strong>{description}</p>
    </div>
  )
}

function IntegrationRows({
  codex,
  claude,
  cursor,
  loading
}: {
  codex: IntegrationDetail
  claude: IntegrationDetail
  cursor: IntegrationDetail
  loading: boolean
}): React.JSX.Element {
  return (
    <div className="integration-rows">
      {[codex, claude, cursor].map((detail) => (
        <div key={detail.provider}>
          <ProviderLogo provider={detail.provider} />
          <span>
            <strong>{providerName(detail.provider)}</strong>
            <small>{detail.binaryPath ? 'Detected locally' : detail.message || 'Not detected'}</small>
          </span>
          <em className={`health-label health-${detail.health}`}>
            <i />
            {loading ? 'Checking' : healthLabels[detail.health]}
          </em>
        </div>
      ))}
    </div>
  )
}

function IntegrationCard({ detail }: { detail: IntegrationDetail }): React.JSX.Element {
  return (
    <article className="integration-card">
      <ProviderLogo provider={detail.provider} />
      <div>
        <span className="integration-card-title">
          <strong>{providerName(detail.provider)}</strong>
          <em className={`health-label health-${detail.health}`}>
            <i />
            {healthLabels[detail.health]}
          </em>
        </span>
        <p>{detail.message || integrationDescription(detail)}</p>
        {detail.binaryPath ? (
          <code title={detail.binaryPath}>{detail.binaryPath}</code>
        ) : null}
      </div>
    </article>
  )
}

function ProviderLogo({ provider }: { provider: Provider }): React.JSX.Element {
  return (
    <span className={`provider-logo provider-${provider}`} aria-hidden="true">
      <img src={`./providers/${provider}.png`} alt="" />
    </span>
  )
}

function providerName(provider: Provider): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude Code'
  return 'Cursor'
}

function integrationDescription(detail: IntegrationDetail): string {
  if (detail.health === 'healthy') {
    return detail.version ? `Connected · ${detail.version}` : 'Hooks are connected.'
  }
  if (detail.health === 'awaiting_trust') {
    return 'Hooks installed; waiting for the first trusted Codex event.'
  }
  if (detail.health === 'not_installed') return 'QPet hooks are not installed.'
  if (detail.health === 'unavailable') return 'Command-line tool was not detected.'
  return 'Check this integration and try again.'
}

function SettingToggle({
  title,
  description,
  checked,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  onChange(value: boolean): Promise<AppSettings>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="setting-row">
      <label id={`${title.replaceAll(' ', '-').toLowerCase()}-label`}>
        <strong>{title}</strong>
        <small>{description}</small>
      </label>
      <button
        className="switch"
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${title.replaceAll(' ', '-').toLowerCase()}-label`}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void onChange(!checked).finally(() => setBusy(false))
        }}
      >
        <span />
      </button>
    </div>
  )
}
