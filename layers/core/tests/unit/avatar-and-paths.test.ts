import { describe, it, expect } from 'vitest'
import { withQueryParams } from '../../server/utils/account-path'
import { avatarImageType, isAllowedAvatarUrl } from '../../server/utils/avatar-image'

describe('withQueryParams', () => {
  it('adds to a path without a query', () => {
    expect(withQueryParams('/account', { email_change: 'success' })).toBe('/account?email_change=success')
  })

  it('keeps an existing query and hash', () => {
    expect(withQueryParams('/settings?tab=account#top', { link: 'failed' })).toBe('/settings?tab=account&link=failed#top')
  })
})

describe('avatarImageType', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0])

  it('recognises the accepted image types', () => {
    expect(avatarImageType(bytes(0xFF, 0xD8, 0xFF, 0xE0))).toBe('image/jpeg')
    expect(avatarImageType(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe('image/png')
    expect(avatarImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(avatarImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp')
  })

  it('rejects anything else', () => {
    expect(avatarImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(avatarImageType(new Uint8Array())).toBeNull()
  })
})

describe('isAllowedAvatarUrl', () => {
  it('allows HTTPS hosts', () => {
    expect(isAllowedAvatarUrl(new URL('https://lh3.googleusercontent.com/a/photo'))).toBe(true)
  })

  it('refuses other schemes and IP addresses', () => {
    expect(isAllowedAvatarUrl(new URL('http://lh3.googleusercontent.com/a/photo'))).toBe(false)
    expect(isAllowedAvatarUrl(new URL('https://169.254.169.254/latest/meta-data'))).toBe(false)
    expect(isAllowedAvatarUrl(new URL('https://10.0.0.5/photo.png'))).toBe(false)
    expect(isAllowedAvatarUrl(new URL('https://[::1]/photo.png'))).toBe(false)
    expect(isAllowedAvatarUrl(new URL('file:///etc/passwd'))).toBe(false)
  })
})
