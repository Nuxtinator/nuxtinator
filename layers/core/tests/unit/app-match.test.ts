import { describe, it, expect } from 'vitest'
import { matchAppByPath, stripOrgPrefix } from '../../app/utils/app-match'

describe('stripOrgPrefix', () => {
  it('removes a concrete or placeholder org segment', () => {
    expect(stripOrgPrefix('/@acme/crm/contacts')).toBe('/crm/contacts')
    expect(stripOrgPrefix('/@:orgSlug/site')).toBe('/site')
    expect(stripOrgPrefix('/@acme')).toBe('/')
  })

  it('leaves unprefixed paths alone', () => {
    expect(stripOrgPrefix('/crm/contacts')).toBe('/crm/contacts')
    expect(stripOrgPrefix('/')).toBe('/')
  })
})

describe('matchAppByPath', () => {
  const apps = [
    { id: 'crm', path: '/crm' },
    { id: 'crm-settings', path: '/crm/settings' },
    { id: 'site', path: '/@acme/site' },
    { id: 'inbox', path: '/inbox' }
  ]
  const match = (p: string) => matchAppByPath(apps, p)?.id ?? null

  it('matches an unprefixed app on a tenant route', () => {
    expect(match('/@acme/crm/contacts')).toBe('crm')
    expect(match('/@acme/inbox')).toBe('inbox')
  })

  it('matches a slug-prefixed app on a tenant route', () => {
    expect(match('/@acme/site/pages')).toBe('site')
  })

  it('matches on single-mode routes', () => {
    expect(match('/crm/contacts')).toBe('crm')
    expect(match('/inbox')).toBe('inbox')
  })

  it('prefers the longest matching path', () => {
    expect(match('/@acme/crm/settings/fields')).toBe('crm-settings')
  })

  it('needs a whole path segment to match', () => {
    expect(match('/@acme/crmx')).toBeNull()
    expect(match('/@acme/dashboard')).toBeNull()
  })
})
