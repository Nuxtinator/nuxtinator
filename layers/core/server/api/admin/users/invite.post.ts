import { randomUUID } from 'node:crypto'
import { readBody, getHeader } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { requireAuth } from '../../../utils/auth'
import { validateRoleNames } from '../../../utils/rbac'
import { logEvent } from '../../../utils/activity-logger'
import { sendTemplateEmail } from '#email'
import { createInvite, findPendingInvite } from '../../../utils/invites'
import { getApps } from '../../../utils/app-settings'
import { setUserAppGrant } from '../../../utils/personal-apps'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Attachment {
  orgId: string
  roles: string[]
}

// Host-admin multi-org invite. Body shape:
//
//   { email?, display_name?, link?: true, attachments: [{ orgId, roles }, ...], apps?: [appId, ...] }
//
// `apps` are personal apps (`registerApp({ scope: 'user' })`) to turn on for
// the user. In multi-tenant mode an invite needs at least one org or app.
//
// Logic:
//   * `link: true` → create a single-use invite link with no email and return
//     its URL for the admin to share.
//   * If a user with `email` exists → silent attach (no email). Insert one
//     membership row per attachment; skip duplicates (409 listing the conflicts).
//     Grant each app.
//   * If not → create an invite for that address (its orgs ride on the invite)
//     and send ONE invite email. No user row exists until it's accepted.
//
// No subset-delegation. Host admin has god-mode by definition; subset is a
// discipline for org-level admins (per Phase 4.2).
export default defineEventHandler(async (event) => {
  const { userId: hostAdminId } = await requireOperatorAdmin(event)
  const admin = requireAuth(event)

  // Org attachments are a multi-tenant concept; the orgs/memberships tables only
  // exist when the tenancy layer is loaded. In single-tenant mode an invite
  // carries no orgs — any attachments in the body are ignored.
  const tenancyEnabled = useRuntimeConfig(event).public.tenancy === true

  const body = await readBody(event)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const display_name = typeof body?.display_name === 'string' ? body.display_name.trim() : ''
  const attachmentsRaw = Array.isArray(body?.attachments) ? body.attachments : null
  const link = body?.link === true
  const appsRaw: unknown[] = Array.isArray(body?.apps) ? body.apps : []

  if (!link && !EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'A valid email is required' })
  }

  const personalAppIds = new Set((await getApps(db)).filter(a => a.installed && a.scope === 'user').map(a => a.id))
  const apps = [...new Set(appsRaw)].map((a) => {
    if (typeof a !== 'string' || !personalAppIds.has(a)) {
      throw createError({ statusCode: 400, statusMessage: `Unknown personal app: ${String(a)}` })
    }
    return a
  })

  if (tenancyEnabled && (!attachmentsRaw || attachmentsRaw.length === 0) && apps.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'attachments must include at least one org, or apps at least one personal app' })
  }

  // Attachments only carry meaning in multi-tenant mode; leave the list empty in
  // single-tenant mode so every membership-related step below is a no-op.
  const attachments: Attachment[] = []
  if (tenancyEnabled) {
    for (const a of attachmentsRaw ?? []) {
      if (typeof a?.orgId !== 'string' || !Array.isArray(a?.roles)) {
        throw createError({ statusCode: 400, statusMessage: 'each attachment requires { orgId, roles }' })
      }
      if (a.roles.some((r: unknown) => typeof r !== 'string')) {
        throw createError({ statusCode: 400, statusMessage: 'roles must be strings' })
      }
      attachments.push({ orgId: a.orgId, roles: Array.from(new Set(a.roles)) })
    }

    // Validate every attachment's org exists + roles are known in that org.
    for (const att of attachments) {
      const org = await (db as any).selectFrom('orgs').select('id').where('id', '=', att.orgId).executeTakeFirst()
      if (!org) {
        throw createError({ statusCode: 400, statusMessage: `Org ${att.orgId} does not exist` })
      }
      const { valid, unknown } = await validateRoleNames(db, att.roles)
      if (!valid) {
        throw createError({
          statusCode: 400,
          statusMessage: `Unknown role(s) for org ${att.orgId}: ${unknown.join(', ')}`
        })
      }
    }
  }

  if (link) {
    const invite = await createInvite(db, {
      email: null,
      display_name: display_name || null,
      invitedBy: hostAdminId,
      orgs: attachments,
      apps
    })

    logEvent({
      eventType: 'invite_link_created',
      tableName: 'invites',
      recordId: invite.id,
      userId: hostAdminId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { attachments, apps }
    }).catch(() => {})

    return {
      invite: { id: invite.id, kind: 'link', url: invite.url, expires_at: invite.expiresAt },
      attachments: attachments.map(a => ({ orgId: a.orgId, status: 'pending' })),
      apps
    }
  }

  const nowIso = new Date().toISOString()

  // Look up existing user by email.
  const existing = await db
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'verified'])
    .where('email', '=', email)
    .executeTakeFirst()

  if (!existing) {
    if (await findPendingInvite(db, email)) {
      throw createError({ statusCode: 409, statusMessage: 'An invitation is already pending for this email. Resend it from the pending invites list.' })
    }

    const invite = await createInvite(db, {
      email,
      display_name: display_name || null,
      invitedBy: hostAdminId,
      orgs: attachments,
      apps
    })

    try {
      await sendTemplateEmail({
        to: email,
        template: 'invite',
        data: {
          userName: display_name,
          inviterName: admin.display_name,
          inviteUrl: invite.url
        }
      })
    } catch (err) {
      console.error('Error sending invite email:', err)
    }

    logEvent({
      eventType: 'invite_sent_multi',
      tableName: 'invites',
      recordId: invite.id,
      userId: hostAdminId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { email, attachments, apps }
    }).catch(() => {})

    return {
      invite: { id: invite.id, kind: 'email', email, expires_at: invite.expiresAt },
      attachments: attachments.map(a => ({ orgId: a.orgId, status: 'pending' })),
      apps
    }
  }

  const userId = existing.id

  // 409 the entire request if the user is already a member of any of the
  // requested orgs — saves the operator from a partial-success state.
  if (tenancyEnabled && attachments.length > 0) {
    const dupes = await (db as any)
      .selectFrom('memberships')
      .select('org_id')
      .where('user_id', '=', userId)
      .where('org_id', 'in', attachments.map(a => a.orgId))
      .execute() as Array<{ org_id: string }>
    if (dupes.length > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: `User is already a member of: ${dupes.map(d => d.org_id).join(', ')}`
      })
    }
  }

  // Insert N membership rows in a single transaction.
  const memberships = attachments.map(att => ({
    id: randomUUID(),
    user_id: userId,
    org_id: att.orgId,
    roles: att.roles,
    created_at: nowIso,
    updated_at: nowIso
  }))

  await db.transaction().execute(async (trx) => {
    if (memberships.length > 0) {
      await (trx as any).insertInto('memberships').values(memberships).execute()
    }
    for (const appId of apps) {
      await setUserAppGrant(trx, { userId, appId, granted: true, grantedBy: hostAdminId })
    }
  })

  const nitro = useNitroApp()
  for (const m of memberships) {
    try {
      await nitro.hooks.callHook('membership.created', {
        membershipId: m.id,
        userId: m.user_id,
        orgId: m.org_id,
        roles: m.roles,
        createdByUserId: hostAdminId
      })
    } catch (err) {
      console.warn('[hook membership.created] handler threw:', err)
    }
  }

  logEvent({
    eventType: 'invite_attached_multi',
    tableName: 'users',
    recordId: userId,
    userId: hostAdminId,
    userAgent: getHeader(event, 'user-agent') || undefined,
    metadata: { email, attachments: attachments.map(a => ({ orgId: a.orgId, roles: a.roles })), apps }
  }).catch(() => {})

  return {
    user: {
      id: userId,
      email,
      display_name: existing.display_name,
      verified: existing.verified
    },
    attachments: attachments.map(a => ({ orgId: a.orgId, status: 'attached' })),
    apps
  }
})
