import { describe, it, expect, beforeEach } from 'vitest'
import { buildRailLinks } from '../../app/utils/rail-links'
import { registerApp, configureApp, getRegisteredApps, getRegisteredApp, __resetAppRegistryForTests } from '../../server/utils/app-registry'
import { registerRailItem, railItemsFor, __resetRailRegistryForTests } from '../../server/utils/rail-registry'

describe('railItemsFor', () => {
  beforeEach(() => __resetRailRegistryForTests())

  it('is undefined for an app with no rail items', () => {
    expect(railItemsFor('crm', new Set())).toBeUndefined()
  })

  it('sorts by order, filters by permission and fills in the org slug', () => {
    registerRailItem({ appId: 'pt', id: 'stats', title: 'Stats', path: '/@:orgSlug/pt/stats', order: 70, requiredPermission: 'pt.stats.read' })
    registerRailItem({ appId: 'pt', id: 'campaigns', title: 'Campaigns', path: '/pt/campaigns', order: 20 })
    registerRailItem({ appId: 'pt', id: 'dashboard', title: 'Dashboard', path: '/pt', order: 10 })

    expect(railItemsFor('pt', new Set())!.map(i => i.id)).toEqual(['dashboard', 'campaigns'])
    expect(railItemsFor('pt', new Set(['pt.stats.read']), 'acme')!.map(i => i.path))
      .toEqual(['/pt', '/pt/campaigns', '/@acme/pt/stats'])
  })

  it('returns an empty list when the caller may see none of the app\'s items', () => {
    registerRailItem({ appId: 'pt', id: 'stats', title: 'Stats', path: '/pt/stats', requiredPermission: 'pt.stats.read' })
    expect(railItemsFor('pt', new Set())).toEqual([])
  })
})

describe('configureApp', () => {
  beforeEach(() => __resetAppRegistryForTests())

  it('relabels and reorders an app whether called before or after registerApp', () => {
    configureApp('crm', { title: 'Intercessors', icon: 'i-lucide-users' })
    registerApp({ id: 'crm', title: 'CRM', path: '/crm', icon: 'i-lucide-contact', order: 30 })
    registerApp({ id: 'inbox', title: 'Inbox', path: '/inbox', order: 35 })
    configureApp('crm', { order: 45 })

    expect(getRegisteredApps().map(a => a.id)).toEqual(['inbox', 'crm'])
    expect(getRegisteredApp('crm')).toMatchObject({ title: 'Intercessors', icon: 'i-lucide-users', order: 45, path: '/crm' })
  })

  it('ignores undefined fields', () => {
    registerApp({ id: 'crm', title: 'CRM', path: '/crm' })
    configureApp('crm', { title: 'Intercessors' })
    configureApp('crm', { title: undefined, order: 45 })
    expect(getRegisteredApp('crm')!.title).toBe('Intercessors')
  })
})

describe('buildRailLinks', () => {
  it('gives an app without rail items one link', () => {
    expect(buildRailLinks([{ id: 'crm', title: 'CRM', path: '/crm', icon: 'i-lucide-contact' }])).toEqual([
      { key: 'crm', appId: 'crm', title: 'CRM', path: '/crm', icon: 'i-lucide-contact', scope: 'org', badge: true }
    ])
  })

  it('interleaves rail items and apps on one order scale', () => {
    const links = buildRailLinks([
      {
        id: 'pt',
        title: 'Prayer Tools',
        path: '/pt',
        rail: [
          { id: 'dashboard', title: 'Dashboard', path: '/pt', order: 10 },
          { id: 'landing', title: 'Landing page', path: '/pt/landing', order: 40 },
          { id: 'email', title: 'Email', path: '/pt/email', order: 60 }
        ]
      },
      { id: 'crm', title: 'Intercessors', path: '/crm', order: 45 },
      { id: 'inbox', title: 'Inbox', path: '/inbox', order: 50 }
    ])
    expect(links.map(l => l.title)).toEqual(['Dashboard', 'Landing page', 'Intercessors', 'Inbox', 'Email'])
  })

  it('puts the badge on the item at the app\'s own path, else the first item', () => {
    const atHome = buildRailLinks([{
      id: 'pt',
      title: 'PT',
      path: '/@:orgSlug/pt',
      rail: [
        { id: 'campaigns', title: 'Campaigns', path: '/pt/campaigns', order: 20 },
        { id: 'dashboard', title: 'Dashboard', path: '/pt', order: 30 }
      ]
    }])
    expect(atHome.filter(l => l.badge).map(l => l.key)).toEqual(['pt:dashboard'])

    const noHome = buildRailLinks([{
      id: 'pt',
      title: 'PT',
      path: '/pt',
      rail: [
        { id: 'campaigns', title: 'Campaigns', path: '/pt/campaigns' },
        { id: 'stats', title: 'Stats', path: '/pt/stats' }
      ]
    }])
    expect(noHome.filter(l => l.badge).map(l => l.key)).toEqual(['pt:campaigns'])
  })

  it('shows nothing for an app whose rail items are all hidden from the caller', () => {
    expect(buildRailLinks([{ id: 'pt', title: 'PT', path: '/pt', rail: [] }])).toEqual([])
  })
})
