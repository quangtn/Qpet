import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EVENT_BODY_LIMIT_BYTES,
  EventServer,
  type ProviderEventHandler
} from '../src/main/event-server'
import type { Provider } from '../src/shared/contracts'

const servers: EventServer[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function makeServer(handler: ProviderEventHandler = vi.fn()): Promise<{
  server: EventServer
  baseUrl: string
  token: string
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'qpet-events-'))
  directories.push(directory)
  const server = new EventServer({ supportDir: directory, onEvent: handler })
  servers.push(server)
  const endpoint = await server.start()
  const token = await readFile(server.tokenFile, 'utf8')
  return { server, baseUrl: endpoint.baseUrl, token, directory }
}

function post(baseUrl: string, provider: Provider, token: string, body: string) {
  return fetch(`${baseUrl}/v1/events/${provider}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body
  })
}

describe('EventServer', () => {
  it('binds to loopback, writes private discovery files, and dispatches providers', async () => {
    const handler = vi.fn<ProviderEventHandler>()
    const { server, baseUrl, token } = await makeServer(handler)

    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const endpointFile = JSON.parse(await readFile(server.endpointFile, 'utf8'))
    expect(endpointFile).toMatchObject({
      host: '127.0.0.1',
      baseUrl,
      tokenFile: server.tokenFile
    })
    expect((await stat(server.tokenFile)).mode & 0o777).toBe(0o600)
    expect((await stat(server.endpointFile)).mode & 0o777).toBe(0o600)

    const response = await post(
      baseUrl,
      'codex',
      token,
      JSON.stringify({ session_id: 'one', cwd: '/tmp/project' })
    )
    expect(response.status).toBe(204)
    expect(handler).toHaveBeenCalledWith('codex', {
      session_id: 'one',
      cwd: '/tmp/project'
    })

    expect((await post(
      baseUrl,
      'cursor',
      token,
      JSON.stringify({ conversation_id: 'cursor-one', cwd: '/tmp/project' })
    )).status).toBe(204)
    expect(handler).toHaveBeenCalledWith('cursor', {
      conversation_id: 'cursor-one',
      cwd: '/tmp/project'
    })

    expect((await post(
      baseUrl,
      'hermes',
      token,
      JSON.stringify({ session_id: 'hermes-one', cwd: '/tmp/project' })
    )).status).toBe(204)
    expect(handler).toHaveBeenCalledWith('hermes', {
      session_id: 'hermes-one',
      cwd: '/tmp/project'
    })
  })

  it('accepts the fixed helper compatibility route with an explicit provider header', async () => {
    const handler = vi.fn<ProviderEventHandler>()
    const { baseUrl, token } = await makeServer(handler)
    const response = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-QPet-Provider': 'claude'
      },
      body: JSON.stringify({ session_id: 'two', cwd: '/tmp/project' })
    })

    expect(response.status).toBe(204)
    expect(handler).toHaveBeenCalledWith('claude', {
      session_id: 'two',
      cwd: '/tmp/project'
    })
  })

  it('rejects missing or stale bearer tokens', async () => {
    const { server, baseUrl, token } = await makeServer()
    const body = JSON.stringify({ session_id: 'one', cwd: '/tmp/project' })

    expect((await post(baseUrl, 'codex', 'wrong-token', body)).status).toBe(401)
    const rotated = await server.rotateToken()
    expect(rotated).not.toBe(token)
    expect((await post(baseUrl, 'codex', token, body)).status).toBe(401)
    expect((await post(baseUrl, 'codex', rotated, body)).status).toBe(204)
    expect(await readFile(server.tokenFile, 'utf8')).toBe(rotated)
  })

  it('rejects malformed and oversized request bodies', async () => {
    const handler = vi.fn<ProviderEventHandler>()
    const { baseUrl, token } = await makeServer(handler)

    expect((await post(baseUrl, 'claude', token, '{bad json')).status).toBe(400)
    expect((await post(baseUrl, 'claude', token, '[]')).status).toBe(400)
    const oversized = JSON.stringify({ data: 'x'.repeat(EVENT_BODY_LIMIT_BYTES) })
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(EVENT_BODY_LIMIT_BYTES)
    expect((await post(baseUrl, 'claude', token, oversized)).status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('removes the endpoint file when stopped', async () => {
    const { server } = await makeServer()
    const endpointFile = server.endpointFile
    await server.stop()
    await expect(readFile(endpointFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
