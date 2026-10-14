// Pure coverage for widget allowed-origin entries, including *.domain wildcards.
import { describe, it, expect } from 'vitest'
import { helpinatorParseOriginEntry, helpinatorOriginAllowed } from '../../server/utils/helpinator-origins'

describe('helpinatorParseOriginEntry', () => {
  it('reduces exact entries to their origin', () => {
    expect(helpinatorParseOriginEntry(' https://www.Example.org/path?q=1 ')).toBe('https://www.example.org')
    expect(helpinatorParseOriginEntry('http://example.org:8080')).toBe('http://example.org:8080')
    expect(helpinatorParseOriginEntry('https://example.org:443')).toBe('https://example.org')
  })

  it('accepts and normalizes subdomain wildcards', () => {
    expect(helpinatorParseOriginEntry('https://*.Prayer.Tools')).toBe('https://*.prayer.tools')
    expect(helpinatorParseOriginEntry('https://*.prayer.tools/')).toBe('https://*.prayer.tools')
    expect(helpinatorParseOriginEntry('http://*.example.co.uk:8080')).toBe('http://*.example.co.uk:8080')
  })

  it('rejects junk, other schemes and unsafe wildcards', () => {
    for (const raw of ['', 'nope', 'ftp://example.org', 'javascript:alert(1)', '*', 'https://*', 'https://*.org',
      'https://*.127.0.0.1', 'https://*.[::1]', 'https://*.*.example.org', 'https://a*.example.org',
      'https://www.*.example.org', '*.example.org']) {
      expect(helpinatorParseOriginEntry(raw), raw).toBeNull()
    }
  })
})

describe('helpinatorOriginAllowed', () => {
  const list = ['https://*.prayer.tools', 'https://www.example.org', 'http://*.dev.test:3000']

  it('matches exact entries', () => {
    expect(helpinatorOriginAllowed('https://www.example.org', list)).toBe(true)
    expect(helpinatorOriginAllowed('https://example.org', list)).toBe(false)
  })

  it('matches subdomains at any depth, not the bare domain', () => {
    expect(helpinatorOriginAllowed('https://app.prayer.tools', list)).toBe(true)
    expect(helpinatorOriginAllowed('https://a.b.prayer.tools', list)).toBe(true)
    expect(helpinatorOriginAllowed('https://prayer.tools', list)).toBe(false)
  })

  it('does not match look-alike domains, other schemes or ports', () => {
    expect(helpinatorOriginAllowed('https://evilprayer.tools', list)).toBe(false)
    expect(helpinatorOriginAllowed('https://prayer.tools.evil.com', list)).toBe(false)
    expect(helpinatorOriginAllowed('http://app.prayer.tools', list)).toBe(false)
    expect(helpinatorOriginAllowed('https://app.prayer.tools:8443', list)).toBe(false)
    expect(helpinatorOriginAllowed('http://a.dev.test:3000', list)).toBe(true)
    expect(helpinatorOriginAllowed('http://a.dev.test', list)).toBe(false)
  })
})
