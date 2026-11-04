// POST /api/context/portfolios/:slug/sections/:key/versions/:id/restore
// Reads the named version's content and saves it as the current section
// content. Creates a new version row at the head — restoration is itself
// an edit.
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../../../../utils/portfolio-helpers'
import { loadSection, saveSectionContent } from '../../../../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const versionId = getRouterParam(event, 'id') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    const section = await loadSection(tx, p.id, key)
    if (!section) throw createError({ statusCode: 404, statusMessage: 'Section not found.' })

    const v = await tx
      .selectFrom('context_section_versions')
      .select(['id', 'content'])
      .where('id', '=', versionId)
      .where('section_id', '=', section.id)
      .executeTakeFirst()
    if (!v) throw createError({ statusCode: 404, statusMessage: 'Version not found.' })

    const { section: updated, versionId: newVersionId } = await saveSectionContent(
      tx, p.id, key, v.content as string, ctx.userId, { source: 'user' }
    )

    logUpdate('context_sections', section.id, ctx.userId, {
      restored_from: v.id,
      new_version_id: newVersionId,
      key
    })

    return {
      id: updated.id,
      key: updated.section_key,
      content: updated.content,
      restored_from: v.id,
      version_id: newVersionId
    }
  })
})
