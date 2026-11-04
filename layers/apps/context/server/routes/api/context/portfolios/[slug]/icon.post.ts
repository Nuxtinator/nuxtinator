// POST /api/context/portfolios/:slug/icon — upload a portfolio icon (image).
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { uploadToS3, validateImageType, validateFileSize } from '#core/server/utils/storage'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../utils/portfolio-helpers'

const MAX_SIZE_MB = 5

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const parts = await readMultipartFormData(event)
    if (!parts) {
      throw createError({ statusCode: 400, statusMessage: 'Expected multipart/form-data.' })
    }
    const filePart = parts.find(part => part.name === 'file' && part.filename)
    if (!filePart) {
      throw createError({ statusCode: 400, statusMessage: 'No "file" field in upload.' })
    }
    const contentType = filePart.type ?? 'application/octet-stream'
    if (!validateImageType(contentType)) {
      throw createError({ statusCode: 415, statusMessage: 'Unsupported image type.' })
    }
    if (!validateFileSize(filePart.data.byteLength, MAX_SIZE_MB)) {
      throw createError({ statusCode: 413, statusMessage: `Icon too large (max ${MAX_SIZE_MB} MB).` })
    }

    const result = await uploadToS3(
      Buffer.from(filePart.data),
      filePart.filename ?? 'icon',
      contentType,
      'public',
      'context'
    )

    const updated = await tx
      .updateTable('context_portfolios')
      .set({ icon_url: result.url, updated_at: sql<Date>`now()` })
      .where('id', '=', p.id)
      .returning(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    logUpdate('context_portfolios', p.id, ctx.userId, { icon_url: result.url })

    return updated
  })
})
