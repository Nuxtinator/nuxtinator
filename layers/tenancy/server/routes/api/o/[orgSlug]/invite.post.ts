import { randomUUID } from 'node:crypto'
import { getHeader } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { validateRoleNames, getRolePermissions } from '#core/server/utils/rbac'
import { logEvent } from '#core/server/utils/activity-logger'
import { createInvite, findPendingInvite } from '#core/server/utils/invites'
import { sendTemplateEmail } from '#email'
import { adminDb } from '#tenant/admin-db'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Per-org admin invite (single org). Subset-delegation enforced against the
// inviter's effective perm set in *this* org.
//
// `link: true` → a single-use invite link with no email, returned for the
// inviter to share. Existing user → silent attach (no email). New address →
// an invite (no user row until it's accepted) and an invite email.
export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, 'org.members.invite', async (tx, ctx) => {
    const body = await readBody(event)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const display_name = typeof body?.display_name === 'string' ? body.display_name.trim() : ''
    const inputRoles = Array.isArray(body?.roles) ? body.roles : null
    const link = body?.link === true

    if (!link && !EMAIL_RE.test(email)) {
      throw createError({ statusCode: 400, statusMessage: 'A valid email is required' })
    }
    if (!inputRoles || inputRoles.some((r: unknown) => typeof r !== 'string')) {
      throw createError({ statusCode: 400, statusMessage: 'roles must be an array of strings' })
    }
    const roles = Array.from(new Set(inputRoles as string[]))

    const { valid, unknown } = await validateRoleNames(tx, roles)
    if (!valid) {
      throw createError({ statusCode: 400, statusMessage: `Unknown role(s): ${unknown.join(', ')}` })
    }

    // Subset-delegation: roles being assigned can't grant a permission the
    // inviter doesn't hold in this org.
    const assigningPerms = await getRolePermissions(tx, roles, ctx.orgId)
    const missing = [...assigningPerms].filter(p => !ctx.perms.has(p))
    if (missing.length > 0) {
      throw createError({
        statusCode: 403,
        statusMessage: `Cannot assign roles granting permissions you don't hold: ${missing.join(', ')}`
      })
    }

    if (link) {
      const invite = await createInvite(tx, {
        email: null,
        display_name: display_name || null,
        invitedBy: ctx.userId,
        orgs: [{ orgId: ctx.orgId, roles }]
      })

      logEvent({
        eventType: 'org_invite_link_created',
        tableName: 'invites',
        recordId: invite.id,
        userId: ctx.userId,
        userAgent: getHeader(event, 'user-agent') || undefined,
        metadata: { orgId: ctx.orgId, roles }
      }, tx).catch(() => {})

      return {
        invite: { id: invite.id, kind: 'link', url: invite.url, expires_at: invite.expiresAt },
        status: 'pending'
      }
    }

    // User lookup hits the global users table — not RLS-scoped.
    const existing = await adminDb
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'verified'])
      .where('email', '=', email)
      .executeTakeFirst()

    if (!existing) {
      if (await findPendingInvite(tx, email, ctx.orgId)) {
        throw createError({ statusCode: 409, statusMessage: 'An invitation is already pending for this email. Resend it from the pending invites list.' })
      }

      const invite = await createInvite(tx, {
        email,
        display_name: display_name || null,
        invitedBy: ctx.userId,
        orgs: [{ orgId: ctx.orgId, roles }]
      })

      const inviter = await adminDb
        .selectFrom('users')
        .select(['display_name', 'email'])
        .where('id', '=', ctx.userId)
        .executeTakeFirst()
      try {
        await sendTemplateEmail({
          to: email,
          template: 'invite',
          data: {
            userName: display_name || undefined,
            inviterName: inviter?.display_name || inviter?.email || 'Someone',
            orgName: ctx.orgName,
            inviteUrl: invite.url
          }
        })
      } catch (err) {
        console.error('Error sending invite email:', err)
      }

      logEvent({
        eventType: 'org_invite_sent',
        tableName: 'invites',
        recordId: invite.id,
        userId: ctx.userId,
        userAgent: getHeader(event, 'user-agent') || undefined,
        metadata: { orgId: ctx.orgId, email, roles }
      }, tx).catch(() => {})

      return {
        invite: { id: invite.id, kind: 'email', email, expires_at: invite.expiresAt },
        status: 'pending'
      }
    }

    const userId = existing.id

    // The membership insert below runs with RLS active and the active org's
    // GUC set, so it'll only succeed against this org. A pre-check makes
    // the error message kinder.
    const dupe = await tx
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', userId)
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirst()
    if (dupe) {
      throw createError({ statusCode: 409, statusMessage: 'User is already a member of this org' })
    }

    const nowIso = new Date().toISOString()
    const membershipId = randomUUID()
    await tx
      .insertInto('memberships')
      .values({
        id: membershipId,
        user_id: userId,
        org_id: ctx.orgId,
        roles,
        created_at: nowIso,
        updated_at: nowIso
      })
      .execute()

    const nitro = useNitroApp()
    try {
      await nitro.hooks.callHook('membership.created', {
        membershipId,
        userId,
        orgId: ctx.orgId,
        roles,
        createdByUserId: ctx.userId
      })
    } catch (err) { console.warn('[hook membership.created]', err) }

    logEvent({
      eventType: 'org_invite_attached',
      tableName: 'memberships',
      recordId: membershipId,
      userId: ctx.userId,
      userAgent: getHeader(event, 'user-agent') || undefined,
      metadata: { orgId: ctx.orgId, email, roles }
    }, tx).catch(() => {})

    return {
      user: { id: userId, email, display_name: existing.display_name },
      membership: { id: membershipId, roles },
      status: 'attached'
    }
  })
})
