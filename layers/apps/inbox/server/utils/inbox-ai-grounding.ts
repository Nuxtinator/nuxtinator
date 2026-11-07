// Grounding-pack assembly for AI drafting. Three inputs, three lifetimes:
//   - static pack   (tone guide + reference docs) — cached per org, 10-min TTL,
//     invalidated cross-instance off max(fetched_at); byte-stable so a caching-
//     capable model hits the prompt cache.
//   - knowledge block (past Q&A) — a SEPARATE cache block so adding an entry
//     doesn't bust the static pack.
//   - contact record — per-request, never cached, EXCLUDES the email address
//     (data minimization: the envelope already carries it).
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { resolveTypePermission, getRecord, getRecordTypeFields } from '#records/server'
import {
  inboxListGroundingDocuments,
  inboxLatestGroundingFetchedAt
} from './inbox-grounding'
import { inboxListActiveKnowledge } from './inbox-knowledge'
import { INBOX_TONE_GUIDE } from './inbox-ai-tone-guide'

type Tx = Transaction<Database>

// Borrow the exact tenant-context type the CRM kernel expects so the contact
// formatter passes the caller's ctx straight through.
type RecordsCtx = Parameters<typeof resolveTypePermission>[1]

const STATIC_PACK_TTL_MS = 10 * 60 * 1000

interface StaticPackEntry {
  text: string
  builtAt: number
  groundingKey: string | null
}

// Per-org cache. Key is the org id, or a sentinel in single mode.
const staticPackCache = new Map<string, StaticPackEntry>()

function cacheKey(orgId: string | null | undefined): string {
  return orgId ?? '__single__'
}

// Drop the cached static pack (all orgs, or one) — called after a grounding sync
// so the next draft rebuilds from the fresh snapshots.
export function resetInboxGroundingCache(orgId?: string | null): void {
  if (orgId === undefined) staticPackCache.clear()
  else staticPackCache.delete(cacheKey(orgId))
}

// The cacheable prefix: tone guide + reference documents. Cached per org; a
// freshness check against max(fetched_at) invalidates it across replicas.
export async function getInboxStaticPack(tx: Tx, orgId: string | null | undefined): Promise<string> {
  const key = cacheKey(orgId)
  const cached = staticPackCache.get(key)
  if (cached && Date.now() - cached.builtAt < STATIC_PACK_TTL_MS) {
    // Serve stale when the freshness check itself fails (prefer availability
    // over rebuilding from a flaky DB).
    const latest = await inboxLatestGroundingFetchedAt(tx).catch(() => undefined)
    if (latest === undefined || latest === cached.groundingKey) return cached.text
  }

  // Read the freshness key BEFORE the snapshots: a sync landing mid-build makes
  // the stored key stale, so the next draft rebuilds rather than missing it.
  const groundingKey = await inboxLatestGroundingFetchedAt(tx).catch(() => null)

  const sections: string[] = [`# VOICE & TONE GUIDE\n\n${INBOX_TONE_GUIDE.trim()}`]

  const docs = await inboxListGroundingDocuments(tx).catch(() => [])
  if (docs.length) {
    const body = docs
      .map(d => `## ${d.title || d.doc_key}\n\n${d.body_text.trim()}`)
      .join('\n\n')
    sections.push(`# REFERENCE CONTENT\n\n${body}`)
  }

  const text = sections.join('\n\n---\n\n')
  staticPackCache.set(key, { text, builtAt: Date.now(), groundingKey })
  return text
}

// Past team answers as a separate cacheable block. Empty string when the KB is
// empty (the draft engine then omits the block entirely).
export async function getInboxKnowledgeBlock(tx: Tx): Promise<string> {
  const entries = await inboxListActiveKnowledge(tx).catch(() => [])
  if (!entries.length) return ''
  const body = entries
    .map((e, i) => `### Q${i + 1} (${e.language})\nQ: ${e.question.trim()}\nA: ${e.answer.trim()}`)
    .join('\n\n')
  return `# PAST ANSWERS FROM THE TEAM (anonymised — reference, do not paste verbatim)\n\n${body}`
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Format the conversation's linked contact record for the prompt: name + the
// record's non-channel field values. Gated on CRM `contacts.read` (never leak a
// contact past CRM permissions). Deliberately EXCLUDES channel-storage fields
// (email, phone) — data minimization; the model has no use for the address.
export async function formatInboxContactRecord(tx: Tx, ctx: RecordsCtx, channelId: string): Promise<string> {
  try {
    const canRead = await resolveTypePermission(tx, ctx, 'contacts', 'read')
    if (!canRead) return 'No linked contact record (contact access is not permitted for this reviewer).'

    const link = await tx
      .selectFrom('crm_contact_channels')
      .innerJoin('records_entries', 'records_entries.id', 'crm_contact_channels.record_id')
      .select('records_entries.id as record_id')
      .where('crm_contact_channels.channel_id', '=', channelId)
      .where('records_entries.record_type', '=', 'contacts')
      .limit(1)
      .executeTakeFirst()
    if (!link) return 'No linked contact record (the sender is not a known contact).'

    const record = await getRecord(tx, ctx, 'contacts', link.record_id)
    const fields = await getRecordTypeFields(tx, 'contacts').catch(() => [])
    const channelKeys = new Set(fields.filter(f => f.storage === 'channels').map(f => f.key))
    const labelByKey = new Map(fields.map(f => [f.key, f.label]))

    const lines: string[] = [`Name: ${record.name || 'Unknown'}`]
    for (const [fieldKey, value] of Object.entries(record.fields)) {
      if (channelKeys.has(fieldKey)) continue
      if (value == null || value === '') continue
      lines.push(`${labelByKey.get(fieldKey) ?? fieldKey}: ${formatFieldValue(value)}`)
    }
    return lines.join('\n')
  } catch {
    return 'No linked contact record available.'
  }
}
