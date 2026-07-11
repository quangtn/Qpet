import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Provider } from '../shared/contracts'

export const EVENT_SERVER_HOST = '127.0.0.1'
export const EVENT_BODY_LIMIT_BYTES = 256 * 1024
export const EVENT_ENDPOINT_FILE_NAME = 'event-endpoint.json'
export const EVENT_TOKEN_FILE_NAME = 'event-token'

export interface EventServerEndpoint {
  version: 1
  host: typeof EVENT_SERVER_HOST
  port: number
  /** Origin only. Canonical hook route is `/v1/events/{provider}`. */
  baseUrl: string
  tokenFile: string
  updatedAt: number
}

export type ProviderEventHandler = (
  provider: Provider,
  payload: Record<string, unknown>
) => void | Promise<unknown>

export interface EventServerOptions {
  onEvent?: ProviderEventHandler
  activityStore?: {
    ingest(provider: Provider, payload: unknown): Promise<unknown>
  }
  /** Electron's user-data/app-support path can be supplied by the caller. */
  supportDir?: string
  endpointFile?: string
  tokenFile?: string
  port?: number
  maxBodyBytes?: number
  now?: () => number
}

/**
 * Authenticated, loopback-only intake for provider hook events.
 *
 * Runtime discovery files:
 * - `<supportDir>/event-endpoint.json` — origin, port, and token-file path
 * - `<supportDir>/event-token` — raw rotating bearer token, mode 0600
 */
export class EventServer {
  readonly endpointFile: string
  readonly tokenFile: string

  private readonly handler: ProviderEventHandler
  private readonly requestedPort: number
  private readonly maxBodyBytes: number
  private readonly now: () => number
  private server?: Server
  private endpoint?: EventServerEndpoint
  private token = ''
  private startPromise?: Promise<EventServerEndpoint>

  constructor(options: EventServerOptions | ProviderEventHandler) {
    const normalizedOptions = typeof options === 'function' ? { onEvent: options } : options
    const supportDir =
      normalizedOptions.supportDir ??
      process.env.QPET_SUPPORT_DIR ??
      join(homedir(), 'Library', 'Application Support', 'QPet')

    const handler =
      normalizedOptions.onEvent ??
      (normalizedOptions.activityStore
        ? (provider: Provider, payload: Record<string, unknown>) =>
            normalizedOptions.activityStore?.ingest(provider, payload)
        : undefined)
    if (!handler) throw new TypeError('EventServer requires onEvent or activityStore')

    this.handler = handler
    this.endpointFile =
      normalizedOptions.endpointFile ?? join(supportDir, EVENT_ENDPOINT_FILE_NAME)
    this.tokenFile = normalizedOptions.tokenFile ?? join(supportDir, EVENT_TOKEN_FILE_NAME)
    this.requestedPort = normalizedOptions.port ?? 0
    this.maxBodyBytes = normalizedOptions.maxBodyBytes ?? EVENT_BODY_LIMIT_BYTES
    this.now = normalizedOptions.now ?? Date.now
  }

  get isRunning(): boolean {
    return Boolean(this.server?.listening && this.endpoint)
  }

  getEndpoint(): EventServerEndpoint | undefined {
    return this.endpoint ? { ...this.endpoint } : undefined
  }

  async start(): Promise<EventServerEndpoint> {
    if (this.endpoint && this.server?.listening) return { ...this.endpoint }
    this.startPromise ??= this.startListening()

    try {
      return await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async rotateToken(): Promise<string> {
    this.token = createBearerToken()
    await writePrivateFileAtomically(this.tokenFile, this.token)
    if (this.endpoint) {
      this.endpoint = { ...this.endpoint, updatedAt: this.now() }
      await writePrivateFileAtomically(
        this.endpointFile,
        `${JSON.stringify(this.endpoint, null, 2)}\n`
      )
    }
    return this.token
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.endpoint = undefined
    this.token = ''

    if (server) {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections?.()
      })
    }

    // A stale token is harmless; a stale endpoint causes needless one-second
    // hook delays, so remove discovery while the listener is stopped.
    await rm(this.endpointFile, { force: true }).catch(() => undefined)
  }

  private async startListening(): Promise<EventServerEndpoint> {
    if (!Number.isInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65_535) {
      throw new RangeError('EventServer port must be between 0 and 65535')
    }
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) {
      throw new RangeError('EventServer maxBodyBytes must be a positive integer')
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server = server

    try {
      const port = await listen(server, this.requestedPort)
      this.token = createBearerToken()
      const endpoint: EventServerEndpoint = {
        version: 1,
        host: EVENT_SERVER_HOST,
        port,
        baseUrl: `http://${EVENT_SERVER_HOST}:${port}`,
        tokenFile: this.tokenFile,
        updatedAt: this.now()
      }
      this.endpoint = endpoint

      await writePrivateFileAtomically(this.tokenFile, this.token)
      await writePrivateFileAtomically(
        this.endpointFile,
        `${JSON.stringify(endpoint, null, 2)}\n`
      )
      return { ...endpoint }
    } catch (error) {
      this.endpoint = undefined
      this.token = ''
      this.server = undefined
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      await rm(this.endpointFile, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    setSecurityHeaders(response)

    const provider = providerForRequest(request)
    if (!provider) {
      if (request.method !== 'POST' && isEventPath(request.url)) {
        response.setHeader('Allow', 'POST')
        send(response, 405, 'Method not allowed')
      } else {
        send(response, 404, 'Not found')
      }
      request.resume()
      return
    }

    if (!authorized(request.headers.authorization, this.token)) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      send(response, 401, 'Unauthorized')
      request.resume()
      return
    }

    const declaredLength = parseContentLength(request.headers['content-length'])
    if (declaredLength !== undefined && declaredLength > this.maxBodyBytes) {
      send(response, 413, 'Payload too large')
      request.resume()
      return
    }

    let body: Buffer
    try {
      body = await readBody(request, this.maxBodyBytes)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        send(response, 413, 'Payload too large')
      } else {
        send(response, 400, 'Invalid request body')
      }
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(body.toString('utf8')) as unknown
    } catch {
      send(response, 400, 'Invalid JSON')
      return
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      send(response, 400, 'Expected a JSON object')
      return
    }

    try {
      await this.handler(provider, payload as Record<string, unknown>)
      response.statusCode = 204
      response.end()
    } catch {
      send(response, 500, 'Event processing failed')
    }
  }
}

class BodyTooLargeError extends Error {}

function providerForRequest(request: IncomingMessage): Provider | null {
  if (request.method !== 'POST') return null
  const pathname = pathOnly(request.url)
  if (pathname === '/v1/events/codex') return 'codex'
  if (pathname === '/v1/events/claude') return 'claude'
  if (pathname === '/v1/events/cursor') return 'cursor'

  // Compatibility route used by the fixed helper. The provider header is
  // accepted only on the exact local endpoint, never as an arbitrary value.
  if (pathname === '/events') {
    const header = request.headers['x-qpet-provider']
    const value = Array.isArray(header) ? header[0] : header
    if (value === 'codex' || value === 'claude' || value === 'cursor') return value
  }
  return null
}

function isEventPath(url: string | undefined): boolean {
  const pathname = pathOnly(url)
  return pathname === '/events' || pathname.startsWith('/v1/events/')
}

function pathOnly(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url, 'http://127.0.0.1').pathname
  } catch {
    return ''
  }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!expectedToken || !header) return false
  const match = /^Bearer\s+([^\s]+)$/i.exec(header)
  if (!match) return false

  const supplied = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    request.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maximumBytes) {
        settled = true
        reject(new BodyTooLargeError())
        request.resume()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, size))
    })
    request.on('aborted', () => {
      if (settled) return
      settled = true
      reject(new Error('Request aborted'))
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, EVENT_SERVER_HOST, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('EventServer did not receive a TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function createBearerToken(): string {
  return randomBytes(32).toString('base64url')
}

async function writePrivateFileAtomically(filePath: string, body: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function send(response: ServerResponse, statusCode: number, message: string): void {
  if (response.writableEnded) return
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end(message)
}
