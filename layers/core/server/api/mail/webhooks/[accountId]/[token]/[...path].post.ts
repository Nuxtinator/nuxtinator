// Provider webhooks: POST /api/mail/webhooks/:accountId/:token/{events|inbound|inbound/mime}.
// The URL token is checked before the provider's own signature; unknown
// accounts and wrong tokens are a 404.
import { useMail } from '#core/server/utils/mail'

export default defineEventHandler(async (event) => {
  const accountId = getRouterParam(event, 'accountId') || ''
  const token = getRouterParam(event, 'token') || ''
  const path = (getRouterParam(event, 'path') || '').split('/').filter(Boolean)
  const kind = path[0]
  if ((kind !== 'events' && kind !== 'inbound') || path.length > 2 || (path[1] && path[1] !== 'mime')) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  const mail = await useMail()
  const rawBody = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  const headers: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers[k] = Array.isArray(v) ? v.join(', ') : v
  const res = await mail.handleWebhook({
    accountId,
    token,
    kind,
    variant: path[1] ?? null,
    headers,
    rawBody: Buffer.from(rawBody)
  })
  setResponseStatus(event, res.status)
  return res.body
})
