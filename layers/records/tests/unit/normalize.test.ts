// Pure unit tests over the channel-value normalizer — no DB, no server.
import { describe, it, expect } from 'vitest'
import { normalizeChannelValue, channelFingerprint } from '../../server/utils/normalize'

describe('normalizeChannelValue email', () => {
  it('lowercases and trims', () => {
    expect(normalizeChannelValue('email', '  JD@Example.COM ')).toEqual({
      normalized: 'jd@example.com',
      valid: true
    })
  })

  it('strips a display-name wrapper', () => {
    expect(normalizeChannelValue('email', 'Jane Doe <Jane@Example.com>')).toEqual({
      normalized: 'jane@example.com',
      valid: true
    })
  })

  it('strips a mailto: prefix', () => {
    expect(normalizeChannelValue('email', 'mailto:Foo@Bar.com')).toEqual({
      normalized: 'foo@bar.com',
      valid: true
    })
  })

  it('rejects values without an @-domain-dot shape', () => {
    expect(normalizeChannelValue('email', 'not-an-email').valid).toBe(false)
    expect(normalizeChannelValue('email', 'a@b').valid).toBe(false)
    expect(normalizeChannelValue('email', 'two words@example.com').valid).toBe(false)
    expect(normalizeChannelValue('email', '').valid).toBe(false)
  })
})

describe('normalizeChannelValue phone', () => {
  it('strips punctuation and keeps digits', () => {
    expect(normalizeChannelValue('phone', '+1 (555) 010-0001')).toEqual({
      normalized: '+15550100001',
      valid: true
    })
  })

  it('keeps the leading + only when the raw value starts with it', () => {
    expect(normalizeChannelValue('phone', '555.010.0001').normalized).toBe('5550100001')
    expect(normalizeChannelValue('phone', '(555) 010 0001').normalized).toBe('5550100001')
  })

  it('enforces the 7-15 digit E.164 length bounds', () => {
    expect(normalizeChannelValue('phone', '123456').valid).toBe(false)
    expect(normalizeChannelValue('phone', '1234567').valid).toBe(true)
    expect(normalizeChannelValue('phone', '123456789012345').valid).toBe(true)
    expect(normalizeChannelValue('phone', '1234567890123456').valid).toBe(false)
  })
})

describe('normalizeChannelValue handle', () => {
  it('drops the @ prefix and lowercases', () => {
    expect(normalizeChannelValue('handle', '@JaneDoe')).toEqual({
      normalized: 'janedoe',
      valid: true
    })
  })

  it('rejects whitespace and empties', () => {
    expect(normalizeChannelValue('handle', 'jane doe').valid).toBe(false)
    expect(normalizeChannelValue('handle', '  ').valid).toBe(false)
  })
})

describe('normalizeChannelValue url', () => {
  it('defaults the scheme to https', () => {
    expect(normalizeChannelValue('url', 'example.com/path')).toEqual({
      normalized: 'https://example.com/path',
      valid: true
    })
  })

  it('normalizes through the URL parser (root gains a trailing slash, host lowercases)', () => {
    expect(normalizeChannelValue('url', 'https://Example.com').normalized).toBe('https://example.com/')
    expect(normalizeChannelValue('url', 'https://example.com/path/').normalized).toBe('https://example.com/path/')
  })

  it('accepts localhost, rejects dotless hosts and non-http protocols', () => {
    expect(normalizeChannelValue('url', 'localhost:3000').valid).toBe(true)
    expect(normalizeChannelValue('url', 'https://intranet').valid).toBe(false)
    expect(normalizeChannelValue('url', 'ftp://example.com').valid).toBe(false)
    expect(normalizeChannelValue('url', 'not a url').valid).toBe(false)
  })
})

describe('normalizeChannelValue freeform', () => {
  it('trims and requires non-empty', () => {
    expect(normalizeChannelValue('freeform', '  hello there  ')).toEqual({
      normalized: 'hello there',
      valid: true
    })
    expect(normalizeChannelValue('freeform', '   ').valid).toBe(false)
  })
})

describe('channelFingerprint', () => {
  it('is a deterministic sha256 over kind:normalized', () => {
    const a = channelFingerprint('email', 'jd@example.com')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(channelFingerprint('email', 'jd@example.com')).toBe(a)
  })

  it('differs by kind and by value', () => {
    const base = channelFingerprint('email', 'jd@example.com')
    expect(channelFingerprint('phone', 'jd@example.com')).not.toBe(base)
    expect(channelFingerprint('email', 'other@example.com')).not.toBe(base)
  })
})
