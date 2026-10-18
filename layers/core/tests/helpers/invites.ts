// Helper to seed a pending invite row directly. Used by both core
// invite-acceptance tests and the tenancy invite tests that test the same path.
import type postgres from 'postgres'
import { createHash, randomUUID } from 'node:crypto'

export interface PendingInvite {
  inviteId: string
  email: string | null
  display_name: string
  token: string
  expiresAt: string
}

export async function createPendingInvite(
  sql: ReturnType<typeof postgres>,
  opts: {
    // `null` makes a shareable link invite with no address.
    email?: string | null
    display_name?: string
    expiresInMs?: number
    invitedBy?: string
    // Personal app ids the invite grants.
    apps?: string[]
  } = {}
): Promise<PendingInvite> {
  const inviteId = randomUUID()
  const email = opts.email === undefined ? `test-core-invite-${randomUUID().slice(0, 8)}@example.com` : opts.email
  const display_name = opts.display_name ?? 'Pending Invite'
  const token = randomUUID()
  const expiresInMs = opts.expiresInMs ?? 7 * 24 * 60 * 60 * 1000
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString()
  const tokenHash = createHash('sha256').update(token).digest('hex')

  await sql`
    INSERT INTO invites (id, token_hash, email, display_name, invited_by, expires_at)
    VALUES (${inviteId}, ${tokenHash}, ${email}, ${display_name}, ${opts.invitedBy ?? null}, ${expiresAt})
  `
  for (const appId of opts.apps ?? []) {
    await sql`INSERT INTO apps (id) VALUES (${appId}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO invite_apps (invite_id, app_id) VALUES (${inviteId}, ${appId})`
  }

  return { inviteId, email, display_name, token, expiresAt }
}
