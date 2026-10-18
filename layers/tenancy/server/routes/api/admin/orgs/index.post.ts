import { randomUUID } from 'node:crypto'
import { adminDb } from '#tenant/admin-db'
import { requireHostAdmin } from '#tenant/server'
import { logEvent } from '#core/server/utils/activity-logger'
import { validateSlug } from '#core/app/utils/slug'
import { getApps } from '#core/server/utils/app-settings'

// Host-admin org creation. Creates the `orgs` row, the initial admin
// `memberships` row, and seeds default-status apps as `org_apps` rows with
// `source='auto'`.
//
// Self-serve org signup (when DT v2 needs it) gets a different endpoint;
// this one is gated by `requireHostAdmin` and is the only path that the
// internal-portfolio operator uses.
export default defineEventHandler(async (event) => {
  const { userId: hostAdminId } = await requireHostAdmin(event)
  const body = await readBody(event)

  const name = (body?.name ?? '').trim()
  const slug = (body?.slug ?? '').trim()
  const initialAdminUserId: string = body?.initialAdminUserId || hostAdminId

  if (name.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'Name must be at least 2 characters.' })
  }
  const slugError = validateSlug(slug)
  if (slugError) {
    throw createError({ statusCode: 400, statusMessage: slugError })
  }

  const initialAdmin = await adminDb
    .selectFrom('users')
    .select('id')
    .where('id', '=', initialAdminUserId)
    .executeTakeFirst()
  if (!initialAdmin) {
    throw createError({ statusCode: 400, statusMessage: 'initialAdminUserId does not exist' })
  }

  const orgId = randomUUID()
  const membershipId = randomUUID()
  const now = new Date().toISOString()

  try {
    await adminDb.transaction().execute(async (trx) => {
      await trx
        .insertInto('orgs')
        .values({ id: orgId, slug, name, created_at: now, updated_at: now })
        .execute()

      await trx
        .insertInto('memberships')
        .values({
          id: membershipId,
          user_id: initialAdminUserId,
          org_id: orgId,
          roles: ['admin'],
          created_at: now,
          updated_at: now
        })
        .execute()

      // Seed every 'default' app so the per-org bootstrap hook
      // (`app.enabled`) fires for each app the new org starts with.
      const defaultApps = (await getApps(trx))
        .filter(a => a.installed && a.created_at !== null && a.status === 'default' && a.scope !== 'user')
      if (defaultApps.length > 0) {
        await trx
          .insertInto('org_apps')
          .values(defaultApps.map(a => ({
            org_id: orgId,
            app_id: a.id,
            enabled: true,
            source: 'auto' as const,
            updated_at: now
          })))
          .execute()
      }
    })
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'An organization with that slug already exists' })
    }
    throw err
  }

  const nitro = useNitroApp()
  try {
    await nitro.hooks.callHook('org.created', { orgId, slug, createdByUserId: hostAdminId })
  } catch (err) { console.warn('[hook org.created]', err) }
  try {
    await nitro.hooks.callHook('membership.created', {
      membershipId,
      userId: initialAdminUserId,
      orgId,
      roles: ['admin'],
      createdByUserId: hostAdminId
    })
  } catch (err) { console.warn('[hook membership.created]', err) }

  // Materialize app.enabled events so layers that bootstrap on enable react
  // to the auto-seed.
  const seededApps = await adminDb
    .selectFrom('org_apps')
    .select('app_id')
    .where('org_id', '=', orgId)
    .execute()
  for (const a of seededApps) {
    try {
      await nitro.hooks.callHook('app.enabled', { orgId, appId: a.app_id })
    } catch (err) { console.warn('[hook app.enabled]', err) }
  }

  logEvent({
    eventType: 'org_created',
    userId: hostAdminId,
    metadata: { orgId, slug, name, initialAdminUserId }
  }).catch(() => {})

  return { id: orgId, slug, name }
})
