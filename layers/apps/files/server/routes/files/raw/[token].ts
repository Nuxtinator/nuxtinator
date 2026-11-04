// GET|HEAD /files/raw/:token  — PUBLIC (no auth). Redirects a shared file's
// token to a short-lived signed bucket URL, so sites can embed it in
// <video>/<img> or link to it for download. `?download=1` serves it as an
// attachment. Every load re-resolves the token, so unsharing cuts off new
// loads immediately and already-issued bucket URLs within
// RAW_LINK_TTL_SECONDS.
//
// Org resolution mirrors /files/site/:token — `withRecordOrgContext`
// resolves the org from the share token itself.

import { withRecordOrgContext } from '#tenant/server'
import { generateSignedUrl } from '#core/server/utils/storage'
import { contentDisposition, RAW_LINK_TTL_SECONDS } from '../../../utils/file-helpers'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  assertMethod(event, ['GET', 'HEAD'])
  const token = getRouterParam(event, 'token') ?? ''

  if (!UUID_RE.test(token)) {
    throw createError({ statusCode: 404, statusMessage: 'Link not found.' })
  }

  const url = await withRecordOrgContext(
    event,
    { table: 'files_items', id: token, idColumn: 'share_token', notFoundMessage: 'Link not found.' },
    async (tx) => {
      const item = await tx
        .selectFrom('files_items')
        .select(['kind', 'storage_key', 'filename', 'mime'])
        .where('share_token', '=', token)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()

      if (!item || item.kind !== 'file' || !item.storage_key) {
        throw createError({ statusCode: 404, statusMessage: 'Link not found.' })
      }

      const download = getQuery(event).download === '1'
      return await generateSignedUrl(item.storage_key, RAW_LINK_TTL_SECONDS, {
        'response-content-type': item.mime ?? 'application/octet-stream',
        'response-content-disposition': contentDisposition(download ? 'attachment' : 'inline', item.filename ?? 'file')
      })
    }
  )

  // no-store so an unshare applies to the next load rather than a cached redirect.
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  return sendRedirect(event, url, 302)
})
