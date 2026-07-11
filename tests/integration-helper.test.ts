import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

interface ReceivedRequest {
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    )
  )
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function invokeHelper(
  supportDir: string,
  provider: string,
  payload: string
): Promise<{ code: number | null; elapsedMs: number }> {
  const startedAt = Date.now()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolve('resources/qpet-hook.sh'), [provider], {
      env: { ...process.env, QPET_SUPPORT_DIR: supportDir },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('helper did not honor its fail-open deadline'))
    }, 3_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolvePromise({ code, elapsedMs: Date.now() - startedAt })
    })
    child.stdin.end(payload)
  })
}

async function listener(): Promise<{
  server: Server
  port: number
  requests: ReceivedRequest[]
  nextRequest: () => Promise<ReceivedRequest>
}> {
  const requests: ReceivedRequest[] = []
  const waiters: Array<(request: ReceivedRequest) => void> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const received = {
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }
      requests.push(received)
      waiters.shift()?.(received)
      response.writeHead(204)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener address')

  return {
    server,
    port: address.port,
    requests,
    nextRequest: () => new Promise((resolvePromise) => waiters.push(resolvePromise))
  }
}

async function writeRuntimeFiles(supportDir: string, port: number, token: string): Promise<void> {
  await mkdir(supportDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(supportDir, 'event-endpoint.json'),
    JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${port}` }),
    { mode: 0o600 }
  )
  await writeFile(join(supportDir, 'event-token'), token, { mode: 0o600 })
}

describe.runIf(process.platform === 'darwin')('qpet-hook helper', () => {
  it('forwards authenticated raw JSON and observes token rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qpet-helper-'))
    temporaryDirectories.push(root)
    const supportDir = join(root, 'Application Support', 'QPet')
    const local = await listener()
    const firstToken = 'first-token-0123456789'
    await writeRuntimeFiles(supportDir, local.port, firstToken)

    const firstRequest = local.nextRequest()
    const firstRun = await invokeHelper(supportDir, 'claude', '{"session_id":"abc"}\n')
    expect(firstRun.code).toBe(0)
    await expect(firstRequest).resolves.toMatchObject({
      url: '/events',
      headers: {
        authorization: `Bearer ${firstToken}`,
        'content-type': 'application/json',
        'x-qpet-provider': 'claude'
      },
      body: '{"session_id":"abc"}'
    })

    const secondToken = 'rotated-token-9876543210'
    await writeFile(join(supportDir, 'event-token'), secondToken, { mode: 0o600 })
    const secondRequest = local.nextRequest()
    const secondRun = await invokeHelper(supportDir, 'codex', '{"session_id":"xyz"}')
    expect(secondRun.code).toBe(0)
    expect((await secondRequest).headers.authorization).toBe(`Bearer ${secondToken}`)

    const cursorRequest = local.nextRequest()
    const cursorRun = await invokeHelper(supportDir, 'cursor', '{"conversation_id":"cursor-1"}')
    expect(cursorRun.code).toBe(0)
    expect((await cursorRequest).headers['x-qpet-provider']).toBe('cursor')
  })

  it('rejects stdin larger than 256 KiB without contacting the listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qpet-helper-large-'))
    temporaryDirectories.push(root)
    const supportDir = join(root, 'support')
    const local = await listener()
    await writeRuntimeFiles(supportDir, local.port, 'oversize-token-0123456789')

    const result = await invokeHelper(supportDir, 'claude', 'x'.repeat(256 * 1024 + 1))
    expect(result.code).toBe(0)
    expect(local.requests).toHaveLength(0)
  })

  it('silently exits zero within the deadline when the listener is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qpet-helper-offline-'))
    temporaryDirectories.push(root)
    const supportDir = join(root, 'support')
    const local = await listener()
    const port = local.port
    await new Promise<void>((resolvePromise) => local.server.close(() => resolvePromise()))
    servers.splice(servers.indexOf(local.server), 1)
    await writeRuntimeFiles(supportDir, port, 'offline-token-0123456789')

    const result = await invokeHelper(supportDir, 'codex', '{}')
    expect(result.code).toBe(0)
    expect(result.elapsedMs).toBeLessThan(1_500)
  })
})
