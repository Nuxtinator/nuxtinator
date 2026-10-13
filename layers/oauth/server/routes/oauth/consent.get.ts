import { getAuthUser } from '#core/server/utils/auth'
import { loadConsentView } from '../../utils/oauth-consent-ssr'
import { getOauthConfig } from '../../utils/oauth-config'

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(status: number, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize access</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --card: #fff;
      --text: #111;
      --text-muted: #555;
      --border: #e5e5e5;
      --primary: #2563eb;
      --primary-text: #fff;
      --neutral-bg: #fff;
      --neutral-border: #d4d4d8;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a;
        --card: #171717;
        --text: #f5f5f5;
        --text-muted: #a1a1aa;
        --border: #27272a;
        --neutral-bg: #27272a;
        --neutral-border: #3f3f46;
      }
    }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem 1rem; }
    .container { max-width: 32rem; margin: 0 auto; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 2rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    p { color: var(--text-muted); line-height: 1.5; }
    .muted { color: var(--text-muted); font-size: 0.875rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; margin-bottom: 0.5rem; }
    .scope-title { font-weight: 600; }
    .scope-desc { color: var(--text-muted); font-size: 0.875rem; margin-top: 0.25rem; }
    .scope { color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; margin-top: 0.25rem; }
    .buttons { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1.5rem; }
    button { padding: 0.75rem 1rem; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
    button.primary { background: var(--primary); color: var(--primary-text); }
    button.neutral { background: var(--neutral-bg); border-color: var(--neutral-border); color: var(--text); }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`.trim()
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  // Don't cache consent pages — they contain CSRF tokens and user-specific data
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const query = getQuery(event)
  const requestId = String(query.request_id || '')

  // Require authentication; redirect to login if not logged in
  const authUser = getAuthUser(event)
  if (!authUser) {
    const cfg = getOauthConfig()
    const url = getRequestURL(event)
    return sendRedirect(event, `${cfg.loginPath}?redirect=${encodeURIComponent(url.pathname + url.search)}`)
  }

  const vm = await loadConsentView(event, requestId)

  if (vm.status === 'unauthorized' || vm.status === 'not_found') {
    setResponseStatus(event, 404)
    return page(404, `
      <div class="card">
        <h1>Request not found</h1>
        <p>The authorization request was not found. Please restart from the client.</p>
      </div>`)
  }
  if (vm.status === 'consumed') {
    setResponseStatus(event, 410)
    return page(410, `
      <div class="card">
        <h1>Already completed</h1>
        <p>This authorization request has already been completed. Please restart from the client.</p>
      </div>`)
  }
  if (vm.status === 'expired') {
    setResponseStatus(event, 410)
    return page(410, `
      <div class="card">
        <h1>Request expired</h1>
        <p>This authorization request has expired. Please restart from the client.</p>
      </div>`)
  }
  if (vm.status === 'missing_csrf') {
    setResponseStatus(event, 400)
    return page(400, `
      <div class="card">
        <h1>Authorization session lost</h1>
        <p>We couldn't find your authorization session. Please restart from the client.</p>
      </div>`)
  }

  const registeredLabel = vm.clientDynamic
    ? 'This app was registered automatically via Dynamic Client Registration.'
    : 'This app was registered by an administrator.'

  const scopeList = (vm.scopeItems ?? []).map(item => `
    <li>
      <div class="scope-title">${escapeHtml(item.title)}</div>
      ${item.description ? `<div class="scope-desc">${escapeHtml(item.description)}</div>` : ''}
      <div class="scope">${escapeHtml(item.scope)}</div>
    </li>`).join('')

  return page(200, `
    <div class="card">
      <h1>Authorize access</h1>
      <p><strong>${escapeHtml(vm.clientName!)}</strong> wants to access your account.</p>
      <p class="muted">${escapeHtml(registeredLabel)}</p>

      <p style="margin-top:1.5rem;font-weight:600;color:var(--text)">The app is requesting permission to:</p>
      <ul>${scopeList}</ul>

      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="request_id" value="${escapeHtml(vm.requestId!)}">
        <input type="hidden" name="csrf_token" value="${escapeHtml(vm.csrfToken!)}">
        <div class="buttons">
          <button type="submit" name="action" value="approve" class="primary">Approve</button>
          <button type="submit" name="action" value="deny" class="neutral">Deny</button>
        </div>
      </form>
    </div>`)
})
