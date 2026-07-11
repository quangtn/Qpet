import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_PRIORITY,
  compareActivities,
  projectNameFor,
  sortActivities
} from '../src/shared/activity'
import { shellQuote } from '../src/shared/shell'
import type { Activity } from '../src/shared/contracts'

function activity(partial: Partial<Activity> & Pick<Activity, 'id' | 'state'>): Activity {
  return {
    provider: 'codex',
    sessionId: partial.id,
    cwd: '/tmp/demo',
    projectName: 'demo',
    summary: 'test',
    updatedAt: 1,
    unread: false,
    live: true,
    ...partial
  }
}

describe('shared activity helpers', () => {
  it('orders by attention priority then recency', () => {
    const sorted = sortActivities([
      activity({ id: 'ready', state: 'ready', updatedAt: 90 }),
      activity({ id: 'blocked', state: 'blocked', updatedAt: 10 }),
      activity({ id: 'needs', state: 'needs_input', updatedAt: 5 }),
      activity({ id: 'running', state: 'running', updatedAt: 50 })
    ])
    expect(sorted.map((item) => item.id)).toEqual(['needs', 'blocked', 'running', 'ready'])
    expect(ACTIVITY_PRIORITY.needs_input).toBeGreaterThan(ACTIVITY_PRIORITY.ready)
  })

  it('breaks ties with activity id', () => {
    const left = activity({ id: 'a', state: 'running', updatedAt: 1 })
    const right = activity({ id: 'b', state: 'running', updatedAt: 1 })
    expect(compareActivities(left, right)).toBeLessThan(0)
  })

  it('derives project names without Node path', () => {
    expect(projectNameFor('/Users/me/GitProjects/qpet/')).toBe('qpet')
    expect(projectNameFor('/')).toBe('/')
  })
})

describe('shared shellQuote', () => {
  it('escapes single quotes for POSIX shells', () => {
    expect(shellQuote("a'b; $(touch nope)")).toBe("'a'\\''b; $(touch nope)'")
  })

  it('rejects empty or unsafe values', () => {
    expect(() => shellQuote('')).toThrow(/Unsafe/)
    expect(() => shellQuote('bad\0value')).toThrow(/Unsafe/)
  })
})
