import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError
} from 'jsonc-parser'

import type {
  InstallResult,
  IntegrationDetail,
  IntegrationStatus,
  Provider
} from '../shared/contracts'
import { shellQuote } from '../shared/shell'
import {
  discoverBinaries,
  type BinaryDiscoveryOptions,
  type DiscoveredBinary
} from './binary-discovery'

export const QPET_HOOK_TAG = 'qpet-v1'
export const QPET_HELPER_NAME = 'qpet-hook.sh'

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'Elicitation',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
] as const

export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'postToolUse',
  'afterAgentResponse',
  'stop',
  'sessionEnd'
] as const

type JsonObject = Record<string, unknown>
type NestedHookEventName = (typeof CODEX_HOOK_EVENTS)[number] | (typeof CLAUDE_HOOK_EVENTS)[number]
type CursorHookEventName = (typeof CURSOR_HOOK_EVENTS)[number]
type HookEventName = NestedHookEventName | CursorHookEventName

export interface IntegrationManagerOptions {
  homeDir?: string
  appSupportDir?: string
  helperSourcePath?: string
  codexHooksPath?: string
  claudeSettingsPath?: string
  cursorHooksPath?: string
  binaryDiscovery?: BinaryDiscoveryOptions
  discover?: () => Promise<Partial<Record<Provider, DiscoveredBinary>>>
  isListenerActive?: () => boolean
  listenerMessage?: () => string | undefined
  now?: () => Date
}

interface ConfigInspection {
  installed: boolean
  error?: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function commandFor(helperPath: string, provider: Provider): string {
  return `QPET_HOOK_TAG=${QPET_HOOK_TAG} ${shellQuote(helperPath)} ${provider}`
}

function qpetHandler(helperPath: string, provider: Provider): JsonObject {
  return {
    type: 'command',
    command: commandFor(helperPath, provider),
    // Leave headroom around the helper's one-second network deadline so the
    // host does not kill it while it is completing its fail-open cleanup.
    timeout: 2,
    statusMessage: 'Updating QPet'
  }
}

export function isQPetHookHandler(value: unknown): boolean {
  if (!isObject(value) || (value.type !== undefined && value.type !== 'command')) return false

  const command = typeof value.command === 'string' ? value.command : ''
  const args = Array.isArray(value.args) ? value.args : []
  return (
    (
      command.includes(`QPET_HOOK_TAG=${QPET_HOOK_TAG}`) &&
      command.includes(QPET_HELPER_NAME)
    ) ||
    args.some((argument) => argument === QPET_HOOK_TAG)
  )
}

function matcherFor(event: NestedHookEventName): string | undefined {
  switch (event) {
    case 'SessionStart':
      return '*'
    case 'PermissionRequest':
    case 'PostToolUse':
    case 'Elicitation':
    case 'Notification':
    case 'StopFailure':
    case 'SessionEnd':
      return '*'
    case 'PreToolUse':
      return '^AskUserQuestion$'
    default:
      return undefined
  }
}

function removeQPetHandlersFromEvent(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Cannot safely update a hook event whose value is not an array')
  }

  return value.flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group]

    const hooks = group.hooks.filter((handler) => !isQPetHookHandler(handler))
    return hooks.length > 0 ? [{ ...group, hooks }] : []
  })
}

function addQPetEvent(
  hooks: JsonObject,
  event: NestedHookEventName,
  helperPath: string,
  provider: Provider
): void {
  const existing = hooks[event] === undefined ? [] : removeQPetHandlersFromEvent(hooks[event])
  const matcher = matcherFor(event)
  hooks[event] = [
    ...existing,
    {
      ...(matcher ? { matcher } : {}),
      hooks: [qpetHandler(helperPath, provider)]
    }
  ]
}

export function mergeQPetHooks(
  config: JsonObject,
  provider: 'codex' | 'claude',
  helperPath: string
): JsonObject {
  const next = structuredClone(config)
  if (next.hooks !== undefined && !isObject(next.hooks)) {
    throw new Error('Cannot safely update settings whose hooks value is not an object')
  }
  const hooks = isObject(next.hooks) ? next.hooks : {}
  next.hooks = hooks

  const events = provider === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS
  for (const event of events) addQPetEvent(hooks, event, helperPath, provider)

  return next
}

function cursorHandler(helperPath: string): JsonObject {
  return {
    command: commandFor(helperPath, 'cursor'),
    timeout: 2
  }
}

function removeQPetCursorHandlers(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Cannot safely update a Cursor hook event whose value is not an array')
  }
  return value.filter((handler) => !isQPetHookHandler(handler))
}

export function mergeQPetCursorHooks(config: JsonObject, helperPath: string): JsonObject {
  const next = structuredClone(config)
  if (next.hooks !== undefined && !isObject(next.hooks)) {
    throw new Error('Cannot safely update Cursor settings whose hooks value is not an object')
  }
  const hooks = isObject(next.hooks) ? next.hooks : {}
  next.version ??= 1
  next.hooks = hooks

  for (const event of CURSOR_HOOK_EVENTS) {
    const existing = hooks[event] === undefined ? [] : removeQPetCursorHandlers(hooks[event])
    hooks[event] = [...existing, cursorHandler(helperPath)]
  }
  return next
}

export function removeQPetHooks(config: JsonObject): JsonObject {
  const next = structuredClone(config)
  if (!isObject(next.hooks)) return next

  for (const [event, value] of Object.entries(next.hooks)) {
    const groups = removeQPetHandlersFromEvent(value)
    if (groups.length > 0) next.hooks[event] = groups
    else delete next.hooks[event]
  }

  if (Object.keys(next.hooks).length === 0) delete next.hooks
  return next
}

export function removeQPetCursorHooks(config: JsonObject): JsonObject {
  const next = structuredClone(config)
  if (!isObject(next.hooks)) return next

  for (const [event, value] of Object.entries(next.hooks)) {
    const handlers = removeQPetCursorHandlers(value)
    if (handlers.length > 0) next.hooks[event] = handlers
    else delete next.hooks[event]
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks
  return next
}

function hasQPetHooks(config: JsonObject, events: readonly NestedHookEventName[]): boolean {
  const hooks = config.hooks
  if (!isObject(hooks)) return false

  return events.every((event) => {
    const groups = hooks[event]
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isObject(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(isQPetHookHandler)
      )
    )
  })
}

function hasQPetCursorHooks(config: JsonObject): boolean {
  const hooks = config.hooks
  if (!isObject(hooks)) return false
  return CURSOR_HOOK_EVENTS.every((event) =>
    Array.isArray(hooks[event]) && hooks[event].some(isQPetHookHandler)
  )
}

interface JsonDocument {
  source: string
  value: JsonObject
}

async function readJsonDocument(path: string): Promise<JsonDocument> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source: '{}\n', value: {} }
    }
    throw error
  }

  const errors: ParseError[] = []
  const value: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true
  })

  if (errors.length > 0 || (value !== undefined && !isObject(value))) {
    throw new Error(`Cannot safely update invalid JSON settings at ${path}`)
  }

  return { source: source.trim() ? source : '{}\n', value: value === undefined ? {} : value }
}

async function readJsonObject(path: string): Promise<JsonObject> {
  return (await readJsonDocument(path)).value
}

function timestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx', mode })

  try {
    await chmod(tempPath, mode)
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function existingMode(path: string, fallback: number): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return fallback
  }
}

async function backupIfPresent(path: string, date: Date): Promise<string | undefined> {
  try {
    await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  const backupPath = `${path}.qpet-backup-${timestamp(date)}-${randomUUID()}`
  await copyFile(path, backupPath)
  return backupPath
}

async function updateConfig(
  path: string,
  update: (config: JsonObject) => JsonObject,
  date: Date
): Promise<boolean> {
  const document = await readJsonDocument(path)
  const current = document.value
  const next = update(current)
  if (isDeepStrictEqual(current, next)) return false

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await backupIfPresent(path, date)
  const mode = await existingMode(path, 0o600)
  const contents = updateHooksJsonc(document.source, current, next)
  await atomicWrite(path, contents.endsWith('\n') ? contents : `${contents}\n`, mode)
  return true
}

function updateHooksJsonc(source: string, current: JsonObject, next: JsonObject): string {
  const currentHooks = isObject(current.hooks) ? current.hooks : {}
  const nextHooks = isObject(next.hooks) ? next.hooks : {}
  const eventNames = new Set([...Object.keys(currentHooks), ...Object.keys(nextHooks)])
  const indentation = source.match(/\n([ \t]+)\S/)?.[1] ?? '  '
  const formattingOptions = {
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.includes('\t') ? 1 : Math.max(1, indentation.length),
    eol: source.includes('\r\n') ? '\r\n' : '\n'
  }

  let updated = source
  const topLevelNames = new Set([...Object.keys(current), ...Object.keys(next)])
  topLevelNames.delete('hooks')
  for (const key of topLevelNames) {
    if (isDeepStrictEqual(current[key], next[key])) continue
    updated = applyEdits(
      updated,
      modify(updated, [key], next[key], { formattingOptions })
    )
  }
  for (const eventName of eventNames) {
    if (isDeepStrictEqual(currentHooks[eventName], nextHooks[eventName])) continue
    updated = updateHookEventJsonc(
      updated,
      eventName,
      currentHooks[eventName],
      nextHooks[eventName],
      formattingOptions
    )
  }

  if (Object.keys(nextHooks).length === 0 && Object.keys(currentHooks).length > 0) {
    updated = applyEdits(updated, modify(updated, ['hooks'], undefined, { formattingOptions }))
  }
  return updated
}

function updateHookEventJsonc(
  source: string,
  eventName: string,
  currentValue: unknown,
  nextValue: unknown,
  formattingOptions: FormattingOptions
): string {
  if (!Array.isArray(currentValue) || !Array.isArray(nextValue)) {
    return applyEdits(
      source,
      modify(source, ['hooks', eventName], nextValue, { formattingOptions })
    )
  }

  const currentWithoutQPet = removeQPetHandlersFromEvent(currentValue)
  const nextWithoutQPet = removeQPetHandlersFromEvent(nextValue)
  if (!isDeepStrictEqual(currentWithoutQPet, nextWithoutQPet)) {
    return applyEdits(
      source,
      modify(source, ['hooks', eventName], nextValue, { formattingOptions })
    )
  }

  // Existing groups may contain both user handlers and an older QPet handler.
  // Remove only the QPet-owned nodes so comments and formatting attached to the
  // user's surviving groups and handlers remain byte-for-byte where possible.
  let updated = source
  for (let groupIndex = currentValue.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = currentValue[groupIndex]
    if (!isObject(group) || !Array.isArray(group.hooks)) continue

    const qpetHandlerIndexes = group.hooks.flatMap((handler, handlerIndex) =>
      isQPetHookHandler(handler) ? [handlerIndex] : []
    )
    if (qpetHandlerIndexes.length === 0) continue

    if (qpetHandlerIndexes.length === group.hooks.length) {
      updated = applyEdits(
        updated,
        modify(updated, ['hooks', eventName, groupIndex], undefined, { formattingOptions })
      )
      continue
    }

    for (const handlerIndex of qpetHandlerIndexes.reverse()) {
      updated = applyEdits(
        updated,
        modify(
          updated,
          ['hooks', eventName, groupIndex, 'hooks', handlerIndex],
          undefined,
          { formattingOptions }
        )
      )
    }
  }

  const qpetGroups = nextValue.filter(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some(isQPetHookHandler)
  )
  let insertionIndex = currentWithoutQPet.length
  for (const group of qpetGroups) {
    updated = applyEdits(
      updated,
      modify(updated, ['hooks', eventName, insertionIndex], group, {
        formattingOptions,
        isArrayInsertion: true
      })
    )
    insertionIndex += 1
  }

  return updated
}

async function inspectConfig(
  path: string,
  events: readonly NestedHookEventName[]
): Promise<ConfigInspection> {
  try {
    return { installed: hasQPetHooks(await readJsonObject(path), events) }
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function inspectCursorConfig(path: string): Promise<ConfigInspection> {
  try {
    return { installed: hasQPetCursorHooks(await readJsonObject(path)) }
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function unavailableDetail(
  provider: Provider,
  inspection: ConfigInspection,
  message: string
): IntegrationDetail {
  return {
    provider,
    installed: inspection.installed,
    health: 'unavailable',
    message
  }
}

const PROVIDER_LABELS: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor'
}

function installMessage(targets: readonly Provider[]): string {
  const labels = targets.map((provider) => PROVIDER_LABELS[provider])
  const list =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
  const trustHint = targets.includes('codex')
    ? ' Review and trust the Codex hooks with /hooks.'
    : ''
  return `QPet hooks installed for ${list}.${trustHint}`
}

export class IntegrationManager {
  readonly homeDir: string
  readonly appSupportDir: string
  readonly helperPath: string
  readonly codexHooksPath: string
  readonly claudeSettingsPath: string
  readonly cursorHooksPath: string

  private readonly helperSourcePath: string
  private readonly options: IntegrationManagerOptions
  private operation: Promise<unknown> = Promise.resolve()

  constructor(options: IntegrationManagerOptions = {}) {
    this.options = options
    this.homeDir = resolve(options.homeDir ?? homedir())
    this.appSupportDir = resolve(
      options.appSupportDir ?? join(this.homeDir, 'Library', 'Application Support', 'QPet')
    )
    this.helperPath = join(this.appSupportDir, QPET_HELPER_NAME)
    this.codexHooksPath = resolve(
      options.codexHooksPath ?? join(this.homeDir, '.codex', 'hooks.json')
    )
    this.claudeSettingsPath = resolve(
      options.claudeSettingsPath ?? join(this.homeDir, '.claude', 'settings.json')
    )
    this.cursorHooksPath = resolve(
      options.cursorHooksPath ?? join(this.homeDir, '.cursor', 'hooks.json')
    )
    this.helperSourcePath = resolve(
      options.helperSourcePath ?? join(process.cwd(), 'resources', QPET_HELPER_NAME)
    )
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private trustedMarkerPath(): string {
    return join(this.appSupportDir, 'codex-hooks-trusted')
  }

  private configPathFor(provider: Provider): string {
    if (provider === 'codex') return this.codexHooksPath
    if (provider === 'claude') return this.claudeSettingsPath
    return this.cursorHooksPath
  }

  private async hasTrustMarker(): Promise<boolean> {
    try {
      await stat(this.trustedMarkerPath())
      return true
    } catch {
      return false
    }
  }

  private async copyHelper(): Promise<void> {
    const contents = await readFile(this.helperSourcePath, 'utf8')
    await mkdir(this.appSupportDir, { recursive: true, mode: 0o700 })

    try {
      const current = await readFile(this.helperPath, 'utf8')
      if (current === contents) {
        await chmod(this.helperPath, 0o700)
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await atomicWrite(this.helperPath, contents, 0o700)
  }

  private async binaries(): Promise<Partial<Record<Provider, DiscoveredBinary>>> {
    if (this.options.discover) return this.options.discover()
    return discoverBinaries({
      homeDir: this.homeDir,
      ...this.options.binaryDiscovery
    })
  }

  async getStatus(): Promise<IntegrationStatus> {
    const [codexInspection, claudeInspection, cursorInspection, binaries, trusted] = await Promise.all([
      inspectConfig(this.codexHooksPath, CODEX_HOOK_EVENTS),
      inspectConfig(this.claudeSettingsPath, CLAUDE_HOOK_EVENTS),
      inspectCursorConfig(this.cursorHooksPath),
      this.binaries(),
      this.hasTrustMarker()
    ])
    const listenerActive = this.options.isListenerActive?.() ?? false

    const detail = (
      provider: Provider,
      inspection: ConfigInspection,
      binary: DiscoveredBinary | undefined
    ): IntegrationDetail => {
      if (inspection.error) {
        return {
          provider,
          installed: false,
          health: 'error',
          message: inspection.error
        }
      }

      if (!binary) {
        return unavailableDetail(provider, inspection, `${provider} executable was not found`)
      }

      if (!binary.capabilities.hooks) {
        return {
          ...unavailableDetail(provider, inspection, 'This version does not expose lifecycle hooks'),
          binaryPath: binary.path,
          version: binary.version
        }
      }

      if (!inspection.installed) {
        return {
          provider,
          installed: false,
          health: 'not_installed',
          binaryPath: binary.path,
          version: binary.version
        }
      }

      if (!listenerActive) {
        return {
          provider,
          installed: true,
          health: 'error',
          binaryPath: binary.path,
          version: binary.version,
          message: 'QPet’s local event listener is unavailable. Restart QPet before using hooks.'
        }
      }

      if (provider === 'codex' && !trusted) {
        return {
          provider,
          installed: true,
          health: 'awaiting_trust',
          binaryPath: binary.path,
          version: binary.version,
          message:
            'Waiting for the first trusted Codex event. In a new Codex CLI session, trust QPet in /hooks if prompted, then send a prompt.'
        }
      }

      return {
        provider,
        installed: true,
        health: 'healthy',
        binaryPath: binary.path,
        version: binary.version,
        ...(
          provider === 'claude' && !binary.capabilities.agentsJson
            ? { message: 'Hooks are active; background-session discovery is unavailable.' }
            : {}
        )
      }
    }

    return {
      codex: detail('codex', codexInspection, binaries.codex),
      claude: detail('claude', claudeInspection, binaries.claude),
      cursor: detail('cursor', cursorInspection, binaries.cursor),
      listenerActive,
      ...(
        listenerActive
          ? {}
          : {
              listenerMessage:
                this.options.listenerMessage?.() ??
                'QPet’s local event listener is not running. Restart QPet, then use Refresh.'
            }
      )
    }
  }

  async install(): Promise<InstallResult> {
    return this.serialized(async () => {
      try {
        const binaries = await this.binaries()
        const targets = (['codex', 'claude', 'cursor'] as const).filter(
          (provider) => binaries[provider]?.capabilities.hooks
        )
        if (targets.length === 0) {
          return {
            ok: false,
            message:
              'No supported Codex, Claude Code, or Cursor CLI was found. Install a provider, then Refresh.',
            status: await this.getStatus()
          }
        }

        // Validate only the configs we will touch so an unused invalid file
        // cannot block installing for a detected provider.
        await Promise.all(
          targets.map((provider) => readJsonObject(this.configPathFor(provider)))
        )
        await this.copyHelper()
        const date = this.options.now?.() ?? new Date()
        let codexChanged = false
        for (const provider of targets) {
          const changed = await updateConfig(
            this.configPathFor(provider),
            (config) =>
              provider === 'cursor'
                ? mergeQPetCursorHooks(config, this.helperPath)
                : mergeQPetHooks(config, provider, this.helperPath),
            date
          )
          if (provider === 'codex') codexChanged = changed
        }

        if (codexChanged) await unlink(this.trustedMarkerPath()).catch(() => undefined)
        return {
          ok: true,
          message: installMessage(targets),
          status: await this.getStatus()
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          status: await this.getStatus()
        }
      }
    })
  }

  async uninstall(): Promise<InstallResult> {
    return this.serialized(async () => {
      try {
        await Promise.all([
          readJsonObject(this.codexHooksPath),
          readJsonObject(this.claudeSettingsPath),
          readJsonObject(this.cursorHooksPath)
        ])
        const date = this.options.now?.() ?? new Date()
        await updateConfig(this.codexHooksPath, removeQPetHooks, date)
        await updateConfig(this.claudeSettingsPath, removeQPetHooks, date)
        await updateConfig(this.cursorHooksPath, removeQPetCursorHooks, date)
        await Promise.all([
          unlink(this.helperPath).catch(() => undefined),
          unlink(this.trustedMarkerPath()).catch(() => undefined)
        ])

        return {
          ok: true,
          message: 'QPet hooks removed.',
          status: await this.getStatus()
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          status: await this.getStatus()
        }
      }
    })
  }

  async markCodexTrusted(): Promise<IntegrationStatus> {
    return this.serialized(async () => {
      await mkdir(this.appSupportDir, { recursive: true, mode: 0o700 })
      await atomicWrite(this.trustedMarkerPath(), `${QPET_HOOK_TAG}\n`, 0o600)
      return this.getStatus()
    })
  }
}
