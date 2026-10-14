import { describe, it, expect } from 'vitest'
import { safeRedirect } from '../server/utils/social-flow'

describe('safeRedirect', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirect('/profile')).toBe('/profile')
    expect(safeRedirect('/settings?tab=account#top')).toBe('/settings?tab=account#top')
  })

  it('refuses anything that leaves the site, including after normalising', () => {
    for (const value of ['https://evil.com', '//evil.com', '/\\evil.com', '/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/./\\evil.com', 'profile']) {
      expect(safeRedirect(value)).toBeNull()
    }
  })
})
