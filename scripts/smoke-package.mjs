import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath =
  process.argv[2] ??
  join(process.cwd(), 'release/mac-arm64/QPet.app/Contents/MacOS/QPet')
const userData = await mkdtemp(join(tmpdir(), 'qpet-package-smoke-'))
const fakeHome = join(userData, 'home')
await mkdir(fakeHome, { recursive: true })

const retry = async (operation, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError ?? new Error('Timed out waiting for QPet')
}

const app = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    QPET_USER_DATA_DIR: userData,
    QPET_HOME_DIR: fakeHome,
    QPET_TEST_MODE: '1',
    QPET_DISABLE_POLLING: '1',
    QPET_SKIP_ONBOARDING: '1'
  }
})

try {
  const pet = await retry(async () => {
    const candidate = app.windows().find((page) => {
      try {
        return new URL(page.url()).searchParams.get('window') === 'pet'
      } catch {
        return false
      }
    })
    if (!candidate) throw new Error('The packaged pet window is not ready')
    return candidate
  })

  await pet.locator('[data-testid="pet"]').waitFor()
  const imageWidth = await retry(async () => {
    const width = await pet
      .locator('.pet-sprite')
      .evaluate((image) => image instanceof HTMLImageElement ? image.naturalWidth : 0)
    if (width <= 0) throw new Error('The packaged pet sprite did not load')
    return width
  })

  const endpoint = await retry(async () =>
    JSON.parse(await readFile(join(userData, 'event-endpoint.json'), 'utf8'))
  )
  const token = await retry(() => readFile(join(userData, 'event-token'), 'utf8'))
  const response = await fetch(`${endpoint.baseUrl}/v1/events/codex`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'package-smoke',
      cwd: '/tmp/qpet-package-smoke',
      prompt: 'This must not be persisted.'
    })
  })
  if (response.status !== 204) {
    throw new Error(`Packaged listener returned HTTP ${response.status}`)
  }

  await retry(async () => {
    const state = await pet.getByTestId('pet').getAttribute('data-state')
    if (state !== 'running') throw new Error(`Expected running, received ${state}`)
  })

  const boundary = await pet.evaluate(() => ({
    process: typeof globalThis.process,
    require: typeof globalThis.require,
    qpet: typeof globalThis.qpet
  }))
  if (
    boundary.process !== 'undefined' ||
    boundary.require !== 'undefined' ||
    boundary.qpet !== 'object'
  ) {
    throw new Error(`Unexpected renderer boundary: ${JSON.stringify(boundary)}`)
  }

  process.stdout.write(
    `Packaged QPet smoke test passed (sprite width ${imageWidth}px, authenticated event received).\n`
  )
} finally {
  await app.close()
  await rm(userData, { recursive: true, force: true })
}
