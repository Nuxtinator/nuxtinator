// Conversation tags. The palette (slug → name/color) is a per-org document in
// core_settings (namespace 'inbox', key 'tags'); conversations store only
// slugs in their jsonb `tags` column. The slug is the stable stored key, so
// renaming a tag's display name never breaks assignments.
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { getSetting, setSetting } from '#core/server/utils/settings-store'
import { INBOX_SETTINGS_NAMESPACE } from './inbox-settings'

type Tx = Transaction<Database>

export const INBOX_SETTING_TAGS = 'tags'

// A closed set of Nuxt UI theme colours so a tag renders directly as a UBadge.
export const INBOX_TAG_COLORS = ['neutral', 'primary', 'secondary', 'info', 'success', 'warning', 'error'] as const
export type InboxTagColor = typeof INBOX_TAG_COLORS[number]
export interface InboxTag { slug: string, name: string, color: InboxTagColor }

function isColor(v: unknown): v is InboxTagColor {
  return typeof v === 'string' && (INBOX_TAG_COLORS as readonly string[]).includes(v)
}

// Lowercase, collapse non-alphanumeric runs to '-', strip leading/trailing '-'.
export function slugifyTag(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Defensive palette coercion — runs on every settings read AND write (via the
// registered `parse`), so a corrupt document can never crash the UI or persist
// junk: non-array → [], entries missing string slug/name dropped, duplicate
// slugs deduped, unknown colour coerced to 'neutral'.
export function sanitizeTagPalette(raw: unknown): InboxTag[] {
  if (!Array.isArray(raw)) return []
  const out: InboxTag[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const slug = typeof e.slug === 'string' ? e.slug : ''
    const name = typeof e.name === 'string' ? e.name : ''
    if (!slug || !name || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, name, color: isColor(e.color) ? e.color : 'neutral' })
  }
  return out
}

export async function inboxListTags(tx: Tx): Promise<InboxTag[]> {
  return await getSetting<InboxTag[]>(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_TAGS)
}

// Create-or-return by derived slug: posting an existing name returns the
// existing tag UNCHANGED (never overwrites its colour), so inline
// create-on-assign can't duplicate or mutate.
export async function inboxCreateTag(tx: Tx, input: { name: string, color?: string }): Promise<InboxTag> {
  const slug = slugifyTag(input.name)
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: 'Tag name must contain a letter or number' })
  }
  const palette = await inboxListTags(tx)
  const existing = palette.find(t => t.slug === slug)
  if (existing) return existing
  const tag: InboxTag = { slug, name: input.name.trim(), color: isColor(input.color) ? input.color : 'neutral' }
  await setSetting(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_TAGS, [...palette, tag])
  return tag
}

export async function inboxDeleteTag(tx: Tx, slug: string): Promise<void> {
  const palette = await inboxListTags(tx)
  const next = palette.filter(t => t.slug !== slug)
  if (next.length !== palette.length) {
    await setSetting(tx, INBOX_SETTINGS_NAMESPACE, INBOX_SETTING_TAGS, next)
  }
  // Strip the slug from every conversation's array (runs even for a slug that
  // wasn't in the palette — cleans orphaned assignments so no ghost chips).
  await sql`
    UPDATE inbox_conversations
    SET tags = tags - ${slug}, updated_at = now()
    WHERE tags @> ${JSON.stringify([slug])}::text::jsonb
  `.execute(tx)
}

// Keep only palette-valid slugs, dedupe, preserve caller order. The API
// silently narrows rather than 400-ing on unknown slugs.
export function inboxSanitizeSlugs(palette: InboxTag[], slugs: unknown): string[] {
  if (!Array.isArray(slugs)) return []
  const valid = new Set(palette.map(t => t.slug))
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of slugs) {
    if (typeof s === 'string' && valid.has(s) && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

// Whole-set replace of a conversation's tags (the caller pre-sanitizes).
export async function inboxSetConversationTags(tx: Tx, id: string, slugs: string[]): Promise<void> {
  await tx
    .updateTable('inbox_conversations')
    .set({ tags: sql`${JSON.stringify(slugs)}::text::jsonb`, updated_at: new Date() })
    .where('id', '=', id)
    .execute()
}

// Union palette-valid slugs into each conversation's tag set, keeping the
// existing tags and their order. Returns the ids that gained at least one
// tag — rows already carrying every slug are untouched.
export async function inboxBulkAddTags(tx: Tx, ids: string[], slugs: string[]): Promise<string[]> {
  if (ids.length === 0 || slugs.length === 0) return []
  const rows = await sql<{ id: string }>`
    UPDATE inbox_conversations c
    SET tags = c.tags || added.tags, updated_at = now()
    FROM (
      SELECT c2.id, COALESCE(
        (SELECT jsonb_agg(v.slug)
          FROM jsonb_array_elements_text(${JSON.stringify(slugs)}::text::jsonb) AS v(slug)
          WHERE NOT (c2.tags ? v.slug)),
        '[]'::jsonb
      ) AS tags
      FROM inbox_conversations c2
      WHERE c2.id IN (${sql.join(ids)})
    ) added
    WHERE c.id = added.id AND added.tags <> '[]'::jsonb
    RETURNING c.id
  `.execute(tx)
  return rows.rows.map(r => r.id)
}

// Per-tag conversation counts for the rail badges. Cross-status folders —
// counts ignore the status filter, excluding only spam as noise.
export async function inboxTagCounts(tx: Tx): Promise<Record<string, number>> {
  const rows = await sql<{ slug: string, count: number }>`
    SELECT t.tag AS slug, COUNT(*)::int AS count
    FROM inbox_conversations c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.tags) AS t(tag)
    WHERE c.status <> 'spam'
    GROUP BY t.tag
  `.execute(tx)
  const out: Record<string, number> = {}
  for (const r of rows.rows) out[r.slug] = Number(r.count)
  return out
}
