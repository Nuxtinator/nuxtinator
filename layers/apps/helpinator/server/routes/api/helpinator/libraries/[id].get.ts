// GET /api/helpinator/libraries/:id — one library with its sources (status,
// counts) and index stats; the admin detail page polls this while a sync runs.
import { withOrgPermission } from '#tenant/server'
import { resolveEmbeddingModel } from '#ai/server'
import { helpinatorGetLibraryOr404, helpinatorLibraryStats, helpinatorListSources } from '../../../../utils/helpinator-libraries'
import { helpinatorAdminLibrary, helpinatorAdminSource } from '../../../../utils/helpinator-admin'
import { helpinatorExpireStaleRuns } from '../../../../utils/helpinator-crawl'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    await helpinatorExpireStaleRuns(tx, library.id)
    const [sources, stats, embeddingModel] = await Promise.all([
      helpinatorListSources(tx, library.id),
      helpinatorLibraryStats(tx, library.id),
      resolveEmbeddingModel(tx)
    ])
    return {
      ...helpinatorAdminLibrary(library),
      sources: sources.map(helpinatorAdminSource),
      stats,
      embedding_model: embeddingModel,
      // Chunks built with another model than the one that resolves now.
      index_stale: stats.models.some(m => m !== embeddingModel)
    }
  })
})
