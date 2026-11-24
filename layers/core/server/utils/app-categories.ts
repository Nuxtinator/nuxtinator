// App categories group apps in the rail, the launcher and the dashboard. Core
// ships `people`, `work` and `tools`; an app with no category, or one this
// registry doesn't know, goes to `more`, which sorts last. A layer names its
// category in `registerApp({ category })`; a host moves an app with
// `configureApp(id, { category })` and adds or renames categories here. An
// org's own arrangement goes on top (app/utils/app-layout.ts).

import { MORE_CATEGORY, type AppCategoryInfo } from '../../app/utils/app-layout'

export interface AppCategory {
  id: string
  title: string
  order?: number
}

const CORE_CATEGORIES: AppCategory[] = [
  { id: 'people', title: 'People', order: 10 },
  { id: 'work', title: 'Work', order: 20 },
  { id: 'tools', title: 'Tools', order: 30 },
  { id: MORE_CATEGORY, title: 'More', order: 1000 }
]

const _categories = new Map<string, AppCategory>()
const _presentation = new Map<string, Partial<Omit<AppCategory, 'id'>>>()

function resetCategories(): void {
  _categories.clear()
  for (const c of CORE_CATEGORIES) _categories.set(c.id, c)
}
resetCategories()

export function registerAppCategory(category: AppCategory): void {
  if (!category || typeof category.id !== 'string' || category.id.length === 0) return
  if (typeof category.title !== 'string' || category.title.length === 0) return
  _categories.set(category.id, category)
}

// Applied whenever the registry is read, so it works whether it runs before or
// after the category is registered.
export function configureAppCategory(id: string, presentation: Partial<Omit<AppCategory, 'id'>>): void {
  if (typeof id !== 'string' || id.length === 0) return
  const defined = Object.fromEntries(Object.entries(presentation).filter(([, v]) => v !== undefined))
  _presentation.set(id, { ..._presentation.get(id), ...defined })
}

export function getAppCategories(): AppCategoryInfo[] {
  return [..._categories.values()]
    .map(c => ({ ...c, ..._presentation.get(c.id) }))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title))
    .map(c => ({ id: c.id, title: c.title }))
}

export function __resetAppCategoriesForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAppCategoriesForTests is not callable in production')
  }
  resetCategories()
  _presentation.clear()
}
