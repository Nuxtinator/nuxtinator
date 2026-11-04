// GET /api/helpinator/libraries — every library in the org with its stats and
// source count (managers only: this is the admin list).
import { withOrgPermission } from '#tenant/server'
import { helpinatorListLibraries, helpinatorLibraryStats, helpinatorListSources } from '../../../../utils/helpinator-libraries'
import { helpinatorAdminLibrary } from '../../../../utils/helpinator-admin'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const libraries = await helpinatorListLibraries(tx)
    return await Promise.all(libraries.map(async l => ({
      ...helpinatorAdminLibrary(l),
      stats: await helpinatorLibraryStats(tx, l.id),
      source_count: l.kind === 'website' ? (await helpinatorListSources(tx, l.id)).length : 0
    })))
  })
})
