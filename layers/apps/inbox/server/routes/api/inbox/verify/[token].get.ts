// GET /api/inbox/verify/:token — public landing for the confirmation link in
// the contact-form auto-ack. Redeems the token and answers with a small
// standalone page (no session, no SPA shell): the visitor has no account here.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(appName: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${appName}</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f6f7; color: #1f2933; }
  main { max-width: 32rem; margin: 12vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { margin: 0; line-height: 1.5; }
  .app { display: block; margin-bottom: 1.5rem; font-size: .85rem; color: #6b7280; }
</style>
</head>
<body>
<main>
  <span class="app">${appName}</span>
  <h1>${title}</h1>
  <p>${body}</p>
</main>
</body>
</html>`
}

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token') ?? ''
  const email = await inboxRedeemVerificationToken(token)

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  const appName = escapeHtml(String(useRuntimeConfig().appName || 'Support'))

  if (!email) {
    setResponseStatus(event, 410)
    return page(
      appName,
      'This link is no longer valid',
      'It may have expired or already been used. Replying to our email confirms your address just as well.'
    )
  }
  return page(
    appName,
    'Email confirmed',
    `Thanks — <strong>${escapeHtml(email)}</strong> is confirmed. Our reply will reach you there.`
  )
})
