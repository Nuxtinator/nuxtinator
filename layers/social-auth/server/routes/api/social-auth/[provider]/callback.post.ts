// Apple answers with a cross-site form POST, which doesn't carry SameSite=Lax
// cookies (the flow cookie, the session). Re-issuing it as a top-level GET to
// the same callback brings them back.
export default defineEventHandler(async (event) => {
  const provider = getRouterParam(event, 'provider') || ''
  if (provider !== 'apple') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })

  const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
  const params = new URLSearchParams()
  for (const key of ['code', 'state', 'user', 'error']) {
    const value = body?.[key]
    if (typeof value === 'string') params.set(key, value)
  }
  return sendRedirect(event, `/api/social-auth/apple/callback?${params.toString()}`, 303)
})
