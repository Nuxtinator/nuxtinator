// CRM suppressions next to the mail kernel's list: crm_013 copies CRM's
// bounces and complaints into the kernel's list and crm_014 clears them from
// CRM's own table, in single and multi mode, after which CRM's checks still
// block them through the kernel. Manual blocks stay CRM's own.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { createHash, randomUUID } from 'node:crypto'
import { Kysely, sql as ksql, type Transaction } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import postgres from 'postgres'
import { getHostAdminDb, cleanupCrmTestData, createCrmOrgWith, withOrgHeader } from '../helpers'
import { up as up023 } from '../../../../core/migrations/023_create_mail_tables'
import { up as up013 } from '../../migrations/crm_013_copy_suppressions_to_mail'
import { up as up014 } from '../../migrations/crm_014_clear_copied_suppressions'
import { isSuppressed } from '../../server/utils/suppression'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

const hash = (address: string) => createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex')

type SuppressedTx = Parameters<typeof isSuppressed>[0]

describe('crm_013 and crm_014', () => {
  const opened: { db: Kysely<unknown>, schema: string }[] = []
  afterAll(async () => {
    for (const { db, schema } of opened) {
      await db.destroy()
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })

  // A scratch schema with the mail tables and CRM's channel tables, shaped as
  // a single-mode database or as one where crm_T001 has already added org_id.
  async function scratch(multi: boolean) {
    const schema = `crm_mail_mig_${multi ? 'multi' : 'single'}_${randomUUID().slice(0, 8)}`
    await sql.unsafe(`CREATE SCHEMA ${schema}`)
    const db = new Kysely<unknown>({
      dialect: new PostgresJSDialect({
        postgres: postgres(process.env.TEST_DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1, connection: { search_path: `${schema},public` } })
      })
    })
    opened.push({ db, schema })
    await up023(db)
    await ksql`
      create table crm_channels (
        id uuid primary key default gen_random_uuid(),
        channel_type text not null,
        normalized_value text not null
        ${multi ? ksql`, org_id uuid` : ksql``}
      )
    `.execute(db)
    await ksql`
      create table crm_channel_suppressions (
        id uuid primary key default gen_random_uuid(),
        channel_id uuid not null references crm_channels(id),
        reason text not null,
        detail text,
        source text,
        created_at timestamptz not null default now(),
        cleared_at timestamptz
      )
    `.execute(db)
    return db
  }

  async function channel(db: Kysely<unknown>, type: string, value: string, orgId: string | null, reason: string | null, cleared = false) {
    const cols = orgId ? ksql`(channel_type, normalized_value, org_id) values (${type}, ${value}, ${orgId}::uuid)` : ksql`(channel_type, normalized_value) values (${type}, ${value})`
    const { rows } = await ksql<{ id: string }>`insert into crm_channels ${cols} returning id`.execute(db)
    const id = rows[0]!.id
    if (reason) {
      await ksql`insert into crm_channel_suppressions (channel_id, reason, source, cleared_at) values (${id}, ${reason}, 'test', ${cleared ? new Date() : null})`.execute(db)
    }
    return id
  }

  async function run(multi: boolean) {
    const db = await scratch(multi)
    const org = multi ? randomUUID() : null
    const ids = {
      bounce: await channel(db, 'email', 'bounce@x.test', org, 'hard_bounce'),
      complaint: await channel(db, 'email', 'complaint@x.test', org, 'complaint'),
      manual: await channel(db, 'email', 'manual@x.test', org, 'manual'),
      phone: await channel(db, 'phone', '+15550100', org, 'hard_bounce'),
      old: await channel(db, 'email', 'old@x.test', org, 'hard_bounce', true),
      clean: await channel(db, 'email', 'clean@x.test', org, null)
    }
    await up013(db)
    await up014(db)
    const kernel = (await ksql<{ address_hash: string, scope: string, org_id: string | null, reason: string }>`
      select address_hash, scope, org_id, reason from mail_suppressions where cleared_at is null order by reason
    `.execute(db)).rows
    const crm = new Map((await ksql<{ channel_id: string, active: boolean }>`
      select channel_id, cleared_at is null as active from crm_channel_suppressions
    `.execute(db)).rows.map(r => [r.channel_id, r.active]))
    return { db, org, ids, kernel, crm }
  }

  // isSuppressed in a transaction with the org GUC set, as the tenant kernel does.
  async function suppressed(db: Kysely<unknown>, org: string | null, channelId: string): Promise<boolean> {
    return await db.transaction().execute(async (tx: Transaction<unknown>) => {
      if (org) await ksql`select set_config('app.current_org', ${org}, true)`.execute(tx)
      return await isSuppressed(tx as unknown as SuppressedTx, channelId)
    })
  }

  it('single mode: bounces go global, complaints to the host; CRM keeps only manual blocks and other channels', async () => {
    const { db, ids, kernel, crm } = await run(false)
    expect(kernel).toEqual([
      { address_hash: hash('complaint@x.test'), scope: 'host', org_id: null, reason: 'complaint' },
      { address_hash: hash('bounce@x.test'), scope: 'global', org_id: null, reason: 'hard_bounce' }
    ])
    expect(Object.fromEntries(Object.entries(ids).filter(([k]) => k !== 'clean').map(([k, id]) => [k, crm.get(id)]))).toEqual({
      bounce: false, complaint: false, manual: true, phone: true, old: false
    })
    expect(await suppressed(db, null, ids.bounce)).toBe(true)
    expect(await suppressed(db, null, ids.complaint)).toBe(true)
    expect(await suppressed(db, null, ids.manual)).toBe(true)
    expect(await suppressed(db, null, ids.old)).toBe(false)
    expect(await suppressed(db, null, ids.clean)).toBe(false)
  })

  it('multi mode: complaints are scoped to the channel\'s org, and block only there', async () => {
    const { db, org, ids, kernel, crm } = await run(true)
    expect(kernel).toEqual([
      { address_hash: hash('complaint@x.test'), scope: 'org', org_id: org, reason: 'complaint' },
      { address_hash: hash('bounce@x.test'), scope: 'global', org_id: null, reason: 'hard_bounce' }
    ])
    expect([crm.get(ids.bounce), crm.get(ids.complaint), crm.get(ids.manual)]).toEqual([false, false, true])
    expect(await suppressed(db, org, ids.bounce)).toBe(true)
    expect(await suppressed(db, org, ids.complaint)).toBe(true)
    expect(await suppressed(db, randomUUID(), ids.complaint)).toBe(false)
    expect(await suppressed(db, randomUUID(), ids.bounce)).toBe(true)
  })
})

describe('isSuppressed in the app', () => {
  async function contactWithEmail(email: string) {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await $fetch<{ id: string }>('/api/records/entries/contacts', { method: 'POST', body: { fields: { name: `test-crm ${email}` } }, ...opts })
    const channels = await $fetch<{ entries: Array<{ channelId: string }> }>(`/api/crm/records/contacts/${rec.id}/channels`, {
      method: 'POST', body: { channelTypeKey: 'email', fieldKey: 'contact_email', value: email }, ...opts
    })
    return { org, opts, recordId: rec.id, channelId: channels.entries[0]!.channelId }
  }

  async function suppressedFlag(ctx: Awaited<ReturnType<typeof contactWithEmail>>): Promise<boolean> {
    const res = await $fetch<{ suppressed: boolean }>(`/api/crm/records/contacts/${ctx.recordId}/consent`, {
      method: 'POST', body: { channelId: ctx.channelId, purpose: 'transactional', status: 'opt_in', source: 'form' }, ...ctx.opts
    })
    return res.suppressed
  }

  it('is true for a manual block, and for a hard bounce on the kernel\'s list', async () => {
    const manual = await contactWithEmail(`manual-${randomUUID().slice(0, 8)}@example.com`)
    expect(await suppressedFlag(manual)).toBe(false)
    await sql`INSERT INTO crm_channel_suppressions (org_id, channel_id, reason, source) VALUES (${manual.org.id}, ${manual.channelId}, 'manual', 'test')`
    expect(await suppressedFlag(manual)).toBe(true)

    const email = `bounced-${randomUUID().slice(0, 8)}@example.com`
    const bounced = await contactWithEmail(email)
    expect(await suppressedFlag(bounced)).toBe(false)
    await sql`INSERT INTO mail_suppressions (address_hash, scope, reason, source, occurred_at) VALUES (${hash(email)}, 'global', 'hard_bounce', 'test', now())`
    try {
      expect(await suppressedFlag(bounced)).toBe(true)
    } finally {
      await sql`DELETE FROM mail_suppressions WHERE address_hash = ${hash(email)}`
    }
  })
})
