// The consent state machine: idempotent grant/revoke (no event spam), the
// append-only compliance log with fingerprint + value snapshot, and the
// canSend delivery gate including its suppression interplay.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  withOrgHeader,
  type AuthHeaders,
  type TestOrg
} from '../helpers'
import { canSend } from '../../server/utils/consent'
import { channelFingerprint } from '@nuxtinator/records/normalize'
import { createKyselyDb } from '../../../../core/server/utils/db-connection'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

// canSend is not exposed over HTTP (senders call it in-process), so it gets
// a direct Kysely connection on the BYPASSRLS test role. The addresses used
// are unique per test, so cross-org visibility doesn't matter here.
const kdb = createKyselyDb<never>(process.env.TEST_DATABASE_URL!)
type CanSendTx = Parameters<typeof canSend>[0]
const asTx = kdb as unknown as CanSendTx
afterAll(async () => { await kdb.destroy() })

interface ConsentResponse {
  channelId: string
  consents: Array<{ purpose: string, status: string, source: string | null }>
  suppressed: boolean
  changed: boolean
}

async function setupContactWithEmail(email: string): Promise<{
  org: TestOrg
  opts: { headers: { cookie: string, 'x-active-org': string } }
  recordId: string
  channelId: string
}> {
  const { org, auth }: { org: TestOrg, auth: AuthHeaders } = await createCrmOrgWith(sql, ['admin'])
  const opts = withOrgHeader(auth, org.slug)
  const rec = await $fetch<{ id: string }>('/api/records/entries/contacts', {
    method: 'POST',
    body: { fields: { name: `test-crm ${email}` } },
    ...opts
  })
  const channels = await $fetch<{ entries: Array<{ channelId: string }> }>(
    `/api/crm/records/contacts/${rec.id}/channels`,
    {
      method: 'POST',
      body: { channelTypeKey: 'email', fieldKey: 'contact_email', value: email },
      ...opts
    }
  )
  return { org, opts, recordId: rec.id, channelId: channels.entries[0]!.channelId }
}

function postConsent(
  ctx: { opts: object, recordId: string, channelId: string },
  status: 'opt_in' | 'opt_out',
  purpose = 'marketing'
): Promise<ConsentResponse> {
  return $fetch<ConsentResponse>(`/api/crm/records/contacts/${ctx.recordId}/consent`, {
    method: 'POST',
    body: { channelId: ctx.channelId, purpose, status, source: 'form' },
    ...ctx.opts
  })
}

describe('grant/revoke idempotency', () => {
  it('re-asserting the current state writes no event', async () => {
    const ctx = await setupContactWithEmail(`idem-${randomUUID().slice(0, 8)}@example.com`)

    const first = await postConsent(ctx, 'opt_in')
    expect(first.changed).toBe(true)
    expect(first.consents).toEqual([
      expect.objectContaining({ purpose: 'marketing', status: 'opt_in' })
    ])

    const second = await postConsent(ctx, 'opt_in')
    expect(second.changed).toBe(false)

    const events = await sql`
      SELECT id FROM crm_consent_events WHERE channel_id = ${ctx.channelId}
    `
    expect(events).toHaveLength(1)
  })

  it('a state flip appends exactly one more event', async () => {
    const ctx = await setupContactWithEmail(`flip-${randomUUID().slice(0, 8)}@example.com`)
    await postConsent(ctx, 'opt_in')
    const revoked = await postConsent(ctx, 'opt_out')
    expect(revoked.changed).toBe(true)
    expect(revoked.consents[0]!.status).toBe('opt_out')

    const events = await sql`
      SELECT event FROM crm_consent_events WHERE channel_id = ${ctx.channelId} ORDER BY occurred_at ASC
    `
    expect(events.map(e => e.event)).toEqual(['grant', 'revoke'])
  })
})

describe('compliance events', () => {
  it('carry the literal value snapshot and the address fingerprint', async () => {
    const email = `proof-${randomUUID().slice(0, 8)}@example.com`
    const ctx = await setupContactWithEmail(email)
    await postConsent(ctx, 'opt_in')

    const events = await sql`
      SELECT channel_value, address_fingerprint, purpose, event, source
      FROM crm_consent_events WHERE channel_id = ${ctx.channelId}
    `
    expect(events).toHaveLength(1)
    expect(events[0]!.channel_value).toBe(email)
    expect(events[0]!.address_fingerprint).toBe(channelFingerprint('email', email))
    expect(events[0]!).toMatchObject({ purpose: 'marketing', event: 'grant', source: 'form' })
  })

  it('400s on unregistered purposes and unlinked channels', async () => {
    const ctx = await setupContactWithEmail(`bad-${randomUUID().slice(0, 8)}@example.com`)

    const badPurpose = await postConsent(ctx, 'opt_in', 'nonsense').catch(e => e)
    expect(badPurpose.statusCode).toBe(400)

    const unlinked = await $fetch(`/api/crm/records/contacts/${ctx.recordId}/consent`, {
      method: 'POST',
      body: {
        channelId: '00000000-0000-4000-8000-000000000000',
        purpose: 'marketing',
        status: 'opt_in',
        source: 'form'
      },
      ...ctx.opts
    }).catch(e => e)
    expect(unlinked.statusCode).toBe(400)
  })
})

describe('canSend', () => {
  it('requires an explicit opt_in', async () => {
    const email = `cansend-${randomUUID().slice(0, 8)}@example.com`
    const ctx = await setupContactWithEmail(email)
    const input = { channelType: 'email', normalizedValue: email, purpose: 'marketing' }

    // Unknown consent state (no row) is not permission.
    expect(await canSend(asTx, input)).toBe(false)
    // Unclaimed addresses can't be sent to at all.
    expect(await canSend(asTx, { ...input, normalizedValue: 'never-claimed@example.com' })).toBe(false)

    await postConsent(ctx, 'opt_in')
    expect(await canSend(asTx, input)).toBe(true)

    await postConsent(ctx, 'opt_out')
    expect(await canSend(asTx, input)).toBe(false)
  })

  it('suppression vetoes an opt_in and clearing restores it', async () => {
    const email = `suppress-${randomUUID().slice(0, 8)}@example.com`
    const ctx = await setupContactWithEmail(email)
    const input = { channelType: 'email', normalizedValue: email, purpose: 'marketing' }

    await postConsent(ctx, 'opt_in')
    expect(await canSend(asTx, input)).toBe(true)

    await sql`
      INSERT INTO crm_channel_suppressions (channel_id, reason, source, org_id)
      VALUES (${ctx.channelId}, 'hard_bounce', 'test', ${ctx.org.id})
    `
    expect(await canSend(asTx, input)).toBe(false)

    // A cleared suppression no longer blocks (cleared rows stay as history).
    await sql`
      UPDATE crm_channel_suppressions SET cleared_at = now() WHERE channel_id = ${ctx.channelId}
    `
    expect(await canSend(asTx, input)).toBe(true)
  })
})
