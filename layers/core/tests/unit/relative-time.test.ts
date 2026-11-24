import { describe, it, expect } from 'vitest'
import { timestampDate, relativeTimeText, exactTimeText, fullTimeText } from '../../app/utils/relative-time'

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
const ago = (ms: number) => new Date(NOW - ms)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('timestampDate', () => {
  it('accepts ISO strings, epoch ms and Dates', () => {
    const d = new Date(NOW)
    expect(timestampDate(d.toISOString())?.getTime()).toBe(NOW)
    expect(timestampDate(NOW)?.getTime()).toBe(NOW)
    expect(timestampDate(d)?.getTime()).toBe(NOW)
  })

  it('returns null for empty or invalid values', () => {
    expect(timestampDate(null)).toBeNull()
    expect(timestampDate(undefined)).toBeNull()
    expect(timestampDate('')).toBeNull()
    expect(timestampDate('not a date')).toBeNull()
  })
})

describe('relativeTimeText', () => {
  it('counts whole units back from now', () => {
    expect(relativeTimeText(ago(30_000), NOW)).toBe('just now')
    expect(relativeTimeText(ago(5 * MIN + 59_000), NOW)).toBe('5m ago')
    expect(relativeTimeText(ago(3 * HOUR + 59 * MIN), NOW)).toBe('3h ago')
    expect(relativeTimeText(ago(2 * DAY + 23 * HOUR), NOW)).toBe('2d ago')
  })

  it('falls back to the date after a week', () => {
    const d = ago(13 * DAY)
    expect(relativeTimeText(d, NOW)).toBe(d.toLocaleDateString())
  })
})

describe('exactTimeText', () => {
  it('includes seconds and leaves out the current year', () => {
    const d = new Date(2026, 2, 11, 14, 32, 7)
    const text = exactTimeText(d, NOW)
    expect(text).toContain('32:07')
    expect(text).not.toContain('2026')
  })

  it('adds the year for another year', () => {
    expect(exactTimeText(new Date(2025, 2, 11, 14, 32, 7), NOW)).toContain('2025')
  })
})

describe('fullTimeText', () => {
  it('includes the year and seconds', () => {
    const text = fullTimeText(new Date(2026, 2, 11, 14, 32, 7))
    expect(text).toContain('2026')
    expect(text).toContain('32:07')
  })
})
