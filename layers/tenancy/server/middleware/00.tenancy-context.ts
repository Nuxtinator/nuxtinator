// Reads the active org from the request and writes `event.context.orgSlug` /
// `orgId` / `orgRoles` for `defineTenantHandler` to pick up.
//
// Two sources, in priority order:
//   1. Path-prefixed routes — `/api/o/<slug>/...` and `/api/admin/orgs/<id>/...`
//      use the slug/id directly from path params. Tenancy-layer admin
//      endpoints live under these prefixes. (Note: PAGE URLs use `/@<slug>/...`
//      for aesthetics, but API routes use `/api/o/<slug>/...` because Nitro's
//      filesystem router doesn't reliably resolve `@` literals in path
//      segments the way Vue Router does for pages.)
//   2. `X-Active-Org` header — for app-layer APIs at `/api/<app>/...`. The
//      tenancy layer's `$fetch` instance injects it from the current page URL.
//
// Membership validation runs once here so handlers don't repeat it. Bare
// admin endpoints (`/api/admin/*` without `/orgs/:orgId`) skip this — they
// have their own gate.
import { adminDb } from '../utils/database-admin'
import { getAuthUser } from '#core/server/utils/auth'

export default defineEventHandler(async (event) => {
  const url = event.path || ''

  // Skip everything that isn't an authenticated app surface.
  if (url.startsWith('/api/auth/')) return
  if (url.startsWith('/api/_')) return // chrome endpoints

  const authUser = getAuthUser(event)
  if (!authUser) return // requireAuth in handlers will 401 cleanly

  let orgSlug: string | undefined
  let orgId: string | undefined

  // Path-based discovery
  const slugMatch = url.match(/^\/api\/o\/([^/]+)\b/)
  if (slugMatch) {
    orgSlug = decodeURIComponent(slugMatch[1]!)
  }
  const adminOrgMatch = url.match(/^\/api\/admin\/orgs\/([0-9a-f-]{36})\b/)
  if (adminOrgMatch) {
    orgId = adminOrgMatch[1]!
  }

  // Header-based discovery
  if (!orgSlug && !orgId) {
    const header = getRequestHeader(event, 'x-active-org')
    if (header) orgSlug = header
  }

  if (!orgSlug && !orgId) return

  // Resolve to the {orgId, slug, name, suspension, membership.roles} bundle.
  // adminDb here is fine because explicit predicates filter to the lookup
  // we need; orgs/memberships are not RLS-protected anyway (auth happens in
  // application code).
  const row = await adminDb
    .selectFrom('orgs')
    .leftJoin('memberships', join =>
      join
        .onRef('memberships.org_id', '=', 'orgs.id')
        .on('memberships.user_id', '=', authUser.userId)
    )
    .select([
      'orgs.id as org_id',
      'orgs.slug as org_slug',
      'orgs.name as org_name',
      'orgs.suspended_at as suspended_at',
      'memberships.id as membership_id',
      'memberships.roles as roles'
    ])
    .where(eb => orgSlug ? eb('orgs.slug', '=', orgSlug) : eb('orgs.id', '=', orgId!))
    .executeTakeFirst()

  if (!row) {
    // Slug refers to nothing OR user isn't a member — same 404 either way.
    // Same for an unknown orgId on `/api/admin/orgs/:id/...` paths: without
    // this, the path param flows straight into the handler and an FK
    // violation on insert surfaces as a noisy 500.
    if (orgSlug || adminOrgMatch) {
      throw createError({
        statusCode: 404,
        statusMessage: 'This organization does not exist or you don\'t have access.'
      })
    }
    return
  }

  // Operator admins on `/api/admin/orgs/:id/...` are allowed without
  // membership; their gate is `requireOperatorAdmin` inside those handlers.
  if (!row.membership_id && !adminOrgMatch) {
    throw createError({
      statusCode: 404,
      statusMessage: 'This organization does not exist or you don\'t have access.'
    })
  }

  // Suspended orgs return 423 for normal traffic. Exception: the host-admin
  // suspend endpoint itself — operator admins must be able to unsuspend, and
  // blocking the very URL that toggles suspension would lock the org out
  // forever. Match both the toggle and the legacy POST shape.
  const isSuspendToggle = adminOrgMatch && /^\/api\/admin\/orgs\/[0-9a-f-]{36}\/suspend\b/.test(url)
  if (row.suspended_at && !isSuspendToggle) {
    throw createError({ statusCode: 423, statusMessage: 'This organization is suspended.' })
  }

  event.context.orgId = row.org_id
  event.context.orgSlug = row.org_slug
  event.context.orgName = row.org_name
  event.context.orgRoles = row.roles ?? []
})
