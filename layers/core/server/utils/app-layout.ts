// An org's arrangement of its apps (in single mode, the deployment's), stored
// as one `core_settings` value. The read happens inside the request's
// transaction, so in multi mode RLS scopes it to the active org.

import type { DbClient } from './settings'
import { clearSetting, getSetting, setSetting } from './settings-store'
import { getAppCategories } from './app-categories'
import { isEmptyAppLayout, parseAppLayout, type AppLayout } from '../../app/utils/app-layout'

export const APP_LAYOUT_NAMESPACE = 'core'
export const SETTING_APP_LAYOUT = 'app_layout'

export async function getAppLayout(tx: DbClient): Promise<AppLayout> {
  return await getSetting<AppLayout>(tx, APP_LAYOUT_NAMESPACE, SETTING_APP_LAYOUT)
}

// Saves a submitted layout, dropping references to categories that don't exist.
// An empty layout clears the override.
export async function saveAppLayout(tx: DbClient, value: unknown): Promise<AppLayout> {
  const parsed = parseAppLayout(value)
  const code = new Set(getAppCategories().map(c => c.id))
  const custom = parsed.custom.filter(id => !code.has(id))
  const known = new Set([...code, ...custom])
  const layout: AppLayout = {
    categories: parsed.categories.filter(id => known.has(id)),
    titles: Object.fromEntries(Object.entries(parsed.titles).filter(([id]) => known.has(id))),
    custom,
    apps: Object.fromEntries(Object.entries(parsed.apps).filter(([id]) => known.has(id)))
  }
  if (isEmptyAppLayout(layout)) await clearSetting(tx, APP_LAYOUT_NAMESPACE, SETTING_APP_LAYOUT)
  else await setSetting(tx, APP_LAYOUT_NAMESPACE, SETTING_APP_LAYOUT, layout)
  return layout
}
