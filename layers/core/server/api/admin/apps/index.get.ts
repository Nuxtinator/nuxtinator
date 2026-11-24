import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { getApps } from '../../../utils/app-settings'
import { getAppCategories } from '../../../utils/app-categories'
import { getAppLayout } from '../../../utils/app-layout'

// Host admin: every registered app (registry-first), with its current DB
// status merged in. Orphan rows (DB row, no registered layer) are
// appended with `installed: false` so they can be purged. In single mode
// `categories` and `layout` group the apps for arranging them; with tenancy
// loaded each org arranges its own.
export default defineEventHandler(async (event) => {
  await requireOperatorAdmin(event)
  const apps = await getApps(db)
  if (useRuntimeConfig().public.tenancy) return { apps }
  return { apps, categories: getAppCategories(), layout: await getAppLayout(db) }
})
