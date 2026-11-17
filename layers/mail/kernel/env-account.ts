// The env account's rows and the fingerprint check. Exactly one process (the
// app) calls syncEnvAccount; every other sending process compares its own
// fingerprint with the recorded one before sending through the env account.
import { sql } from 'kysely'
import type { Kernel } from './context'
import { jsonb } from './json'

const RECHECK_MS = 30_000

export async function syncEnvAccount(k: Kernel): Promise<void> {
  const cfg = k.envAccount
  if (!cfg) {
    k.log('[mail] no env account: MAIL_DOMAIN (or MAILGUN_DOMAIN) is not set')
    return
  }
  await k.db.transaction().execute(async (tx) => {
    let account = await tx.selectFrom('mail_accounts').selectAll().where('source', '=', 'env').executeTakeFirst()
    if (account) {
      account = await tx
        .updateTable('mail_accounts')
        .set({ provider: cfg.provider, env_fingerprint: k.envFingerprint, updated_at: sql`now()` })
        .where('id', '=', account.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    } else {
      await sql`
        INSERT INTO mail_accounts (source, provider, capabilities, env_fingerprint)
        VALUES ('env', ${cfg.provider}, '{}'::jsonb, ${k.envFingerprint})
        ON CONFLICT (source) WHERE source = 'env' DO NOTHING
      `.execute(tx)
      account = await tx.selectFrom('mail_accounts').selectAll().where('source', '=', 'env').executeTakeFirstOrThrow()
    }

    const existing = await tx.selectFrom('mail_domains').selectAll().where('source', '=', 'env').executeTakeFirst()
    if (existing) {
      await tx
        .updateTable('mail_domains')
        .set({
          domain: cfg.domain,
          from_domain: cfg.fromDomain,
          send_account_id: account.id,
          ownership_status: 'verified',
          // The operator who set the env vars vouches for the domain; a
          // corrected key is tried again after a 401 marked it failed.
          send_status: 'verified',
          send_error: null
        })
        .where('id', '=', existing.id)
        .execute()
    } else {
      // A UI row for the same name gives way: the env domain is the one the
      // operator configured.
      await tx.deleteFrom('mail_domains')
        .where(sql`lower(domain)`, '=', cfg.domain)
        .where('org_id', 'is', null)
        .where('source', '=', 'ui')
        .execute()
      await tx
        .insertInto('mail_domains')
        .values({
          source: 'env',
          org_id: null,
          domain: cfg.domain,
          ownership_status: 'verified',
          from_domain: cfg.fromDomain,
          send_account_id: account.id,
          receive_account_id: null,
          setup_mode: 'manual',
          send_status: 'verified',
          dns_records: jsonb([]),
          provider_refs: jsonb({})
        })
        .execute()
    }
    // An org can't hold a name the env domain uses.
    await tx.deleteFrom('mail_domains')
      .where(sql`lower(domain)`, '=', cfg.domain)
      .where('org_id', 'is not', null)
      .execute()
  })
  k.envCheck = { status: k.envFingerprint ? 'ok' : 'missing', at: Date.now() }
}

export async function envAccountStatus(k: Kernel): Promise<'ok' | 'missing' | 'mismatch'> {
  const row = await k.db.selectFrom('mail_accounts').select('env_fingerprint').where('source', '=', 'env').executeTakeFirst()
  if (!row?.env_fingerprint || !k.envFingerprint) return 'missing'
  return row.env_fingerprint === k.envFingerprint ? 'ok' : 'mismatch'
}

export async function checkEnvAccount(k: Kernel): Promise<'ok' | 'missing' | 'mismatch'> {
  if (k.envCheck && Date.now() - k.envCheck.at < RECHECK_MS) return k.envCheck.status
  const status = await envAccountStatus(k)
  if (status !== 'ok' && k.envCheck?.status !== status) {
    k.log(`[mail] env-account sends paused: ${status === 'missing' ? 'no fingerprint recorded yet' : 'this process\'s mail environment differs from the app\'s'}`)
  }
  k.envCheck = { status, at: Date.now() }
  return status
}
