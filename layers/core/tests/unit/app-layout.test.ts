import { describe, it, expect, beforeEach } from 'vitest'
import {
  arrangeApps,
  emptyAppLayout,
  isEmptyAppLayout,
  layoutWithAppMoved,
  layoutWithCategoryAdded,
  layoutWithCategoryMoved,
  layoutWithCategoryTitle,
  layoutWithoutCategory,
  parseAppLayout,
  type AppLayout
} from '../../app/utils/app-layout'
import { buildRailLinks, buildRailSections } from '../../app/utils/rail-links'
import { registerApp, configureApp, getRegisteredApp, __resetAppRegistryForTests } from '../../server/utils/app-registry'
import { registerAppCategory, configureAppCategory, getAppCategories, __resetAppCategoriesForTests } from '../../server/utils/app-categories'

const CATEGORIES = [
  { id: 'people', title: 'People' },
  { id: 'work', title: 'Work' },
  { id: 'tools', title: 'Tools' },
  { id: 'more', title: 'More' }
]

const APPS = [
  { id: 'views', title: 'Views', category: 'work' },
  { id: 'context', title: 'Context', category: 'work' },
  { id: 'inbox', title: 'Inbox', category: 'people' },
  { id: 'crm', title: 'CRM', category: 'people' },
  { id: 'files', title: 'Files', category: 'tools' },
  { id: 'feedback', title: 'Feedback', category: 'tools' },
  { id: 'signal', title: 'Signal' },
  { id: 'odd', title: 'Odd', category: 'nope' }
]

const shape = (layout: AppLayout, opts?: { includeEmpty?: boolean }) =>
  arrangeApps(APPS, CATEGORIES, layout, opts).map(c => [c.id, c.apps.map(a => a.id)])

describe('arrangeApps', () => {
  it('groups by category in code order, A–Z inside, unknown and missing in More', () => {
    expect(shape(emptyAppLayout())).toEqual([
      ['people', ['crm', 'inbox']],
      ['work', ['context', 'views']],
      ['tools', ['feedback', 'files']],
      ['more', ['odd', 'signal']]
    ])
  })

  it('sorts by order before title and leaves out empty categories unless asked', () => {
    const apps = [{ id: 'b', title: 'B', category: 'work', order: 1 }, { id: 'a', title: 'A', category: 'work' }]
    expect(arrangeApps(apps, CATEGORIES, emptyAppLayout()).map(c => [c.id, c.apps.map(a => a.id)]))
      .toEqual([['work', ['b', 'a']]])
    expect(arrangeApps(apps, CATEGORIES, emptyAppLayout(), { includeEmpty: true }).map(c => c.id))
      .toEqual(['people', 'work', 'tools', 'more'])
  })

  it('puts the org\'s placed apps first and the rest after them', () => {
    const layout = { ...emptyAppLayout(), apps: { work: ['views', 'signal'] } }
    const work = arrangeApps([...APPS, { id: 'zeta', title: 'Zeta', category: 'work' }], CATEGORIES, layout)
      .find(c => c.id === 'work')!
    expect(work.apps.map(a => [a.id, a.position])).toEqual([['views', 0], ['signal', 1], ['context', null], ['zeta', null]])
  })

  it('ignores lists for categories that no longer exist', () => {
    const layout = { ...emptyAppLayout(), apps: { gone: ['crm'] } }
    expect(shape(layout)[0]).toEqual(['people', ['crm', 'inbox']])
  })
})

describe('layout edits', () => {
  const arranged = (layout: AppLayout) => arrangeApps(APPS, CATEGORIES, layout, { includeEmpty: true })

  it('moves an app within its category', () => {
    const next = layoutWithAppMoved(emptyAppLayout(), arranged(emptyAppLayout()), 'views', 'work', 0)
    expect(next.apps).toEqual({ work: ['views', 'context'] })
    expect(shape(next)[1]).toEqual(['work', ['views', 'context']])
  })

  it('moves an app to another category and out of any list it was in', () => {
    let layout = layoutWithAppMoved(emptyAppLayout(), arranged(emptyAppLayout()), 'views', 'work', 0)
    layout = layoutWithAppMoved(layout, arranged(layout), 'views', 'tools', 1)
    expect(layout.apps).toEqual({ work: ['context'], tools: ['feedback', 'views', 'files'] })
    expect(shape(layout)).toEqual([
      ['people', ['crm', 'inbox']],
      ['work', ['context']],
      ['tools', ['feedback', 'views', 'files']],
      ['more', ['odd', 'signal']]
    ])
  })

  it('reorders categories', () => {
    const next = layoutWithCategoryMoved(emptyAppLayout(), arranged(emptyAppLayout()), 'tools', 0)
    expect(next.categories).toEqual(['tools', 'people', 'work', 'more'])
    expect(shape(next).map(([id]) => id)).toEqual(['tools', 'people', 'work', 'more'])
  })

  it('stores a built-in title only while it differs from the code\'s', () => {
    const work = arranged(emptyAppLayout()).find(c => c.id === 'work')!
    const renamed = layoutWithCategoryTitle(emptyAppLayout(), work, ' Projects ')
    expect(renamed.titles).toEqual({ work: 'Projects' })
    expect(layoutWithCategoryTitle(renamed, work, '').titles).toEqual({})
    expect(layoutWithCategoryTitle(renamed, work, 'Work').titles).toEqual({})
  })

  it('adds a category before More and removes it again, sending its apps home', () => {
    let layout = layoutWithCategoryMoved(emptyAppLayout(), arranged(emptyAppLayout()), 'tools', 0)
    layout = layoutWithCategoryAdded(layout, 'c-dev', 'Dev')
    expect(layout.categories).toEqual(['tools', 'people', 'work', 'c-dev', 'more'])
    layout = layoutWithAppMoved(layout, arranged(layout), 'files', 'c-dev', 0)
    expect(arranged(layout).find(c => c.id === 'c-dev')).toMatchObject({ title: 'Dev', custom: true, defaultTitle: null })
    expect(shape(layout).find(([id]) => id === 'c-dev')).toEqual(['c-dev', ['files']])

    layout = layoutWithoutCategory(layout, 'c-dev')
    expect(layout).toEqual({ categories: ['tools', 'people', 'work', 'more'], titles: {}, custom: [], apps: {} })
    expect(shape(layout)[0]).toEqual(['tools', ['feedback', 'files']])
  })

  it('places a new category before More when the order was never changed', () => {
    const layout = layoutWithCategoryAdded(emptyAppLayout(), 'c-dev', 'Dev')
    expect(layout.categories).toEqual([])
    expect(arranged(layout).map(c => c.id)).toEqual(['people', 'work', 'tools', 'c-dev', 'more'])
  })
})

describe('parseAppLayout', () => {
  it('drops malformed parts and keeps an app in its first list', () => {
    expect(parseAppLayout({
      categories: ['work', 'work', 'Bad Id', 3],
      titles: { work: '  Projects  ', tools: '', 'x y': 'nope' },
      custom: ['c-1', 'c-1'],
      apps: { work: ['views', 'views', 'crm'], people: ['crm', 'inbox'], 'x y': ['a'] }
    })).toEqual({
      categories: ['work'],
      titles: { work: 'Projects' },
      custom: ['c-1'],
      apps: { work: ['views', 'crm'], people: ['inbox'] }
    })
  })

  it('reads garbage as an empty layout', () => {
    expect(isEmptyAppLayout(parseAppLayout(null))).toBe(true)
    expect(isEmptyAppLayout(parseAppLayout('x'))).toBe(true)
  })
})

describe('app categories registry', () => {
  beforeEach(() => {
    __resetAppCategoriesForTests()
    __resetAppRegistryForTests()
  })

  it('ships people, work and tools, with More last', () => {
    expect(getAppCategories().map(c => c.id)).toEqual(['people', 'work', 'tools', 'more'])
  })

  it('takes a host\'s categories and renames', () => {
    registerAppCategory({ id: 'prayer', title: 'Prayer', order: 15 })
    configureAppCategory('people', { title: 'Intercessors' })
    expect(getAppCategories()).toEqual([
      { id: 'people', title: 'Intercessors' },
      { id: 'prayer', title: 'Prayer' },
      { id: 'work', title: 'Work' },
      { id: 'tools', title: 'Tools' },
      { id: 'more', title: 'More' }
    ])
  })

  it('lets a host move an app with configureApp', () => {
    registerApp({ id: 'helpinator', title: 'Helpinator', path: '/helpinator', category: 'tools' })
    configureApp('helpinator', { category: 'people' })
    expect(getRegisteredApp('helpinator')?.category).toBe('people')
  })
})

describe('buildRailLinks with an arrangement', () => {
  it('keeps placed apps in the org\'s order, each app\'s items together, then the rest by order', () => {
    const links = buildRailLinks([
      { id: 'b', title: 'B', path: '/b', order: 1, position: null },
      { id: 'pt', title: 'PT', path: '/pt', position: 1, rail: [
        { id: 'two', title: 'Two', path: '/pt/two', order: 20 },
        { id: 'one', title: 'One', path: '/pt', order: 10 }
      ] },
      { id: 'a', title: 'A', path: '/a', position: 0 }
    ])
    expect(links.map(l => l.key)).toEqual(['a', 'pt:one', 'pt:two', 'b'])
  })
})

describe('buildRailSections', () => {
  const shapeOf = (sections: ReturnType<typeof buildRailSections>) => sections.map(s => [s.title, s.links.map(l => l.key)])

  it('shows a rail item under the category it names, after the apps the org placed there', () => {
    const apps = [
      { id: 'site', title: 'Site', path: '/site', category: 'work', rail: [
        { id: 'dashboard', title: 'Dashboard', path: '/site', order: 10 },
        { id: 'contacts', title: 'Contacts', path: '/site/contacts', order: 20, category: 'people' }
      ] },
      { id: 'crm', title: 'CRM', path: '/crm', category: 'people', order: 30 }
    ]
    const sections = buildRailSections(apps, CATEGORIES, { ...emptyAppLayout(), apps: { people: ['crm'] } })
    expect(shapeOf(sections)).toEqual([
      ['People', ['crm', 'site:contacts']],
      ['Work', ['site:dashboard']]
    ])
    expect(sections.flatMap(s => s.links).filter(l => l.badge && l.appId === 'site').map(l => l.key)).toEqual(['site:dashboard'])
  })

  it('gives a category with no apps a heading for the items that name it, with the org\'s order and title', () => {
    const apps = [{ id: 'site', title: 'Site', path: '/site', rail: [
      { id: 'dashboard', title: 'Dashboard', path: '/site' },
      { id: 'campaigns', title: 'Campaigns', path: '/site/campaigns', category: 'tools' }
    ] }]
    const layout = { ...emptyAppLayout(), categories: ['tools'], titles: { tools: 'Prayer' } }
    expect(shapeOf(buildRailSections(apps, CATEGORIES, layout))).toEqual([
      ['Prayer', ['site:campaigns']],
      ['More', ['site:dashboard']]
    ])
  })

  it('keeps an item naming an unknown category with its app, in one untitled section', () => {
    const apps = [{ id: 'site', title: 'Site', path: '/site', category: 'work', rail: [
      { id: 'dashboard', title: 'Dashboard', path: '/site' },
      { id: 'odd', title: 'Odd', path: '/site/odd', category: 'nope' }
    ] }]
    expect(buildRailSections(apps, CATEGORIES, emptyAppLayout()).map(s => [s.id, s.title, s.links.map(l => l.key)]))
      .toEqual([['all', '', ['site:dashboard', 'site:odd']]])
  })
})
