// POST /api/mail/webhooks/:accountId/:token/... — the URL token is checked
// before the provider's signature, and signed events go through the trust rules.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { getHostAdminDb, type AuthHeaders } from '../helpers'
import {
  addressHash, api, cleanupCoreMailData, createMailAdmin, createMailOrg, envAccount, fakeSignature, MAIL_ENV, postRaw,
  tenancyLoaded, testAddress, testDomain, webhookPaths
} from './helpers'

const SIGNING = MAIL_ENV.MAIL_FAKE_SIGNING_KEY

function signedEvents(events: Record<string, unknown>[], key = SIGNING) {
  const body = JSON.stringify({ events })
  return { body, headers: { 'x-fake-signature': fakeSignature(key, body) } }
}

describe('mail webhooks', () => {
  const sql = getHostAdminDb()
  let auth: AuthHeaders
  let envPaths: Awaited<ReturnType<typeof webhookPaths>>

  beforeAll(async () => {
    auth = (await createMailAdmin(sql)).auth
    envPaths = await webhookPaths(auth, (await envAccount(sql)).id)
  })

  afterAll(async () => {
    await cleanupCoreMailData(sql)
  })

  const rowsFor = (address: string) => sql<{ reason: string, scope: string, org_id: string | null, cleared_at: Date | null, cleared_reason: string | null }[]>`
    SELECT reason, scope, org_id, cleared_at, cleared_reason FROM mail_suppressions WHERE address_hash = ${addressHash(address)} ORDER BY created_at`

  it('a wrong token is 404; the right token with a bad signature is 401', async () => {
    const { body, headers } = signedEvents([])
    const wrong = envPaths.events.replace(/\/[0-9a-f]{40}\/events$/, `/${'0'.repeat(40)}/events`)
    expect(wrong).not.toBe(envPaths.events)
    expect((await postRaw(wrong, body, headers)).status).toBe(404)
    expect((await postRaw(envPaths.events, body, { 'x-fake-signature': '0'.repeat(64) })).status).toBe(401)
    expect((await postRaw(envPaths.events, body)).status).toBe(401)
    expect((await postRaw(envPaths.events, body, headers)).status).toBe(200)
  })

  it('a token from an older version of the account is 404', async () => {
    const { account } = await api<{ account: { id: string } }>('/api/admin/mail/accounts', {
      method: 'POST', body: { provider: 'fake', label: 'test-core-mail-hook', credentials: { apiKey: 'k1', signingKey: 'test-core-mail-sig' } }, ...auth
    })
    const old = await webhookPaths(auth, account.id)
    const { body, headers } = signedEvents([], 'test-core-mail-sig')
    expect((await postRaw(old.events, body, headers)).status).toBe(200)
    await sql`UPDATE mail_accounts SET webhook_token_version = webhook_token_version + 1 WHERE id = ${account.id}`
    expect((await postRaw(old.events, body, headers)).status).toBe(404)
    const fresh = await webhookPaths(auth, account.id)
    expect(fresh.events).not.toBe(old.events)
    expect((await postRaw(fresh.events, body, headers)).status).toBe(200)
  })

  it('inbound to a domain nobody receives for is 200 and dropped', async () => {
    const mime = ['From: a@outside.test', `To: someone@${testDomain('unknown')}`, 'Subject: hi', '', 'hello'].join('\r\n')
    const res = await postRaw(envPaths.inboundMime, mime, {
      'content-type': 'message/rfc822',
      'x-fake-signature': fakeSignature(SIGNING, mime),
      'x-fake-envelope-to': `someone@${testDomain('unknown')}`
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'dropped' })
  })

  it('signed events on the host env account suppress per the trust rules', async () => {
    const bounced = testAddress('bounce')
    const complainedOrg = testAddress('complaint-org')
    const complainedHost = testAddress('complaint-host')
    const deferred = testAddress('deferred')
    const org = await tenancyLoaded(sql) ? await createMailOrg(sql) : null
    const at = (ms: number) => new Date(Date.now() - ms).toISOString()
    const { body, headers } = signedEvents([
      { type: 'bounced', permanent: true, recipient: bounced, occurredAt: at(60_000), detail: 'test-core-mail event' },
      { type: 'deferred', recipient: deferred, occurredAt: at(60_000), detail: 'test-core-mail event' },
      { type: 'complained', recipient: complainedHost, occurredAt: at(60_000), detail: 'test-core-mail event' },
      ...(org ? [{ type: 'complained', recipient: complainedOrg, orgId: org.id, occurredAt: at(60_000), detail: 'test-core-mail event' }] : [])
    ])
    const res = await postRaw(envPaths.events, body, headers)
    expect(res).toMatchObject({ status: 200, body: { status: 'ok' } })

    expect(await rowsFor(bounced)).toEqual([expect.objectContaining({ reason: 'hard_bounce', scope: 'global', org_id: null, cleared_at: null })])
    expect(await rowsFor(complainedHost)).toEqual([expect.objectContaining({ reason: 'complaint', scope: 'host', org_id: null })])
    if (org) expect(await rowsFor(complainedOrg)).toEqual([expect.objectContaining({ reason: 'complaint', scope: 'org', org_id: org.id })])
    expect(await rowsFor(deferred)).toEqual([])

    // A delivery older than the bounce clears nothing; a later one clears it.
    const early = signedEvents([{ type: 'delivered', recipient: bounced, occurredAt: at(120_000), detail: 'test-core-mail event' }])
    await postRaw(envPaths.events, early.body, early.headers)
    expect((await rowsFor(bounced))[0]!.cleared_at).toBeNull()
    const late = signedEvents([{ type: 'delivered', recipient: bounced, occurredAt: at(0), detail: 'test-core-mail event' }])
    await postRaw(envPaths.events, late.body, late.headers)
    expect((await rowsFor(bounced))[0]).toMatchObject({ cleared_reason: 'delivered' })
  })
})
