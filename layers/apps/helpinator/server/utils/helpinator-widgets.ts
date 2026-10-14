// Widget records: CRUD for the admin side and the public config shape the
// embeddable fetches on load. Kernel-style — every function takes the caller's
// scope `tx` (RLS restricts it to one org in multi mode).
import { z } from 'zod'
import { sql, type Selectable, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { HelpinatorAppearance } from '../database/schema'
import { helpinatorAssertLibraries } from './helpinator-libraries'
import { helpinatorParseOriginEntry } from './helpinator-origins'

type Tx = Transaction<Database>

export type HelpinatorWidgetRow = Selectable<Database['helpinator_widgets']>

export const HELPINATOR_DEFAULT_APPEARANCE: Required<HelpinatorAppearance> = {
  primary_color: '#2563eb',
  position: 'bottom-right',
  title: 'Need help?',
  greeting: 'Hi! Ask me anything about this site.',
  placeholder: 'Type your question…',
  handoff_prompt: 'Still need help? Leave your email and someone from our team will get back to you.'
}

const HEX_RE = /^#[0-9a-f]{6}$/i

const TEXT_LIMITS: Record<'title' | 'greeting' | 'placeholder' | 'handoff_prompt', number> = {
  title: 80,
  greeting: 500,
  placeholder: 120,
  handoff_prompt: 500
}

// Coerce stored/submitted appearance into the known fields. Unknown keys are
// dropped; an invalid colour or position falls back to the default; empty text
// means "use the default".
export function helpinatorSanitizeAppearance(raw: unknown): HelpinatorAppearance {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: HelpinatorAppearance = {}
  if (typeof src.primary_color === 'string' && HEX_RE.test(src.primary_color.trim())) {
    out.primary_color = src.primary_color.trim().toLowerCase()
  }
  if (src.position === 'bottom-right' || src.position === 'bottom-left') out.position = src.position
  for (const [key, max] of Object.entries(TEXT_LIMITS) as [keyof typeof TEXT_LIMITS, number][]) {
    const v = src[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, max)
  }
  return out
}

// What gets stored: only the fields that differ from the code defaults, so a
// later change to a default reaches every widget that never overrode it.
export function helpinatorAppearanceOverrides(raw: unknown): HelpinatorAppearance {
  const out: HelpinatorAppearance = {}
  for (const [k, v] of Object.entries(helpinatorSanitizeAppearance(raw)) as [keyof HelpinatorAppearance, string][]) {
    if (v !== HELPINATOR_DEFAULT_APPEARANCE[k]) (out as Record<string, string>)[k] = v
  }
  return out
}

export function helpinatorResolvedAppearance(stored: unknown): Required<HelpinatorAppearance> {
  return { ...HELPINATOR_DEFAULT_APPEARANCE, ...helpinatorSanitizeAppearance(stored) }
}

// Reduce each entry to a bare origin (scheme://host[:port]) or a subdomain
// wildcard (scheme://*.domain[:port]); invalid entries are rejected so a typo
// surfaces in the form instead of silently blocking.
export function helpinatorNormalizeOrigins(list: string[]): string[] {
  const out = new Set<string>()
  for (const raw of list) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const origin = helpinatorParseOriginEntry(trimmed)
    if (!origin) throw createError({ statusCode: 400, statusMessage: `Invalid origin: ${trimmed}` })
    out.add(origin)
  }
  return [...out]
}

export const HELPINATOR_MAX_STARTER_QUESTIONS = 6
const STARTER_QUESTION_MAX = 200

// Trimmed, de-duplicated, blanks dropped.
export function helpinatorNormalizeStarterQuestions(list: string[]): string[] {
  return [...new Set(list.map(q => q.trim()).filter(Boolean))]
}

export const HelpinatorWidgetInput = z.object({
  name: z.string().trim().min(1).max(200),
  library_ids: z.array(z.string().uuid()).min(1).max(20),
  default_library_id: z.string().uuid(),
  // Preloaded section when the default library is a portfolio; ignored otherwise.
  default_section_key: z.string().trim().max(200).nullable().default(null),
  allowed_origins: z.array(z.string().max(500)).max(50).default([]),
  daily_message_cap: z.number().int().min(1).max(100_000).default(500),
  enabled: z.boolean().default(true),
  appearance: z.record(z.unknown()).default({}),
  extra_instructions: z.string().max(4000).default(''),
  starter_questions: z.array(z.string().max(STARTER_QUESTION_MAX)).max(HELPINATOR_MAX_STARTER_QUESTIONS).default([])
})
export type HelpinatorWidgetInputValue = z.infer<typeof HelpinatorWidgetInput>

// Every listed library must exist in this org (RLS), the default must be one
// of them, and when the default is a portfolio the preloaded section (if any)
// must belong to it. Returns the section key to store ('' → null).
async function assertBinding(tx: Tx, input: HelpinatorWidgetInputValue): Promise<string | null> {
  const libraries = await helpinatorAssertLibraries(tx, input.library_ids, input.default_library_id)
  const def = libraries.find(l => l.id === input.default_library_id)!
  const key = input.default_section_key?.trim() || null
  if (def.kind !== 'portfolio' || !def.portfolio_id) return null
  if (!key) return null
  const section = await tx
    .selectFrom('context_section_definitions')
    .select('id')
    .where('portfolio_id', '=', def.portfolio_id)
    .where('key', '=', key)
    .executeTakeFirst()
  if (!section) throw createError({ statusCode: 400, statusMessage: 'Unknown section for the default library\'s portfolio' })
  return key
}

// Same libraries, same default: order-insensitive.
export function helpinatorSameBinding(
  a: { library_ids: string[], default_library_id: string | null },
  b: { library_ids: string[], default_library_id: string | null }
): boolean {
  const sa = [...a.library_ids].sort().join(',')
  const sb = [...b.library_ids].sort().join(',')
  return sa === sb && a.default_library_id === b.default_library_id
}

export async function helpinatorListWidgets(tx: Tx): Promise<HelpinatorWidgetRow[]> {
  return await tx.selectFrom('helpinator_widgets').selectAll().orderBy('name').execute()
}

export const HELPINATOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function helpinatorGetWidget(tx: Tx, id: string): Promise<HelpinatorWidgetRow | null> {
  if (!HELPINATOR_UUID_RE.test(id)) return null
  const row = await tx.selectFrom('helpinator_widgets').selectAll().where('id', '=', id).executeTakeFirst()
  return row ?? null
}

export async function helpinatorGetWidgetOr404(tx: Tx, id: string): Promise<HelpinatorWidgetRow> {
  const row = await helpinatorGetWidget(tx, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Widget not found' })
  return row
}

export async function helpinatorCreateWidget(
  tx: Tx,
  input: HelpinatorWidgetInputValue,
  userId: string
): Promise<HelpinatorWidgetRow> {
  const sectionKey = await assertBinding(tx, input)
  return await tx
    .insertInto('helpinator_widgets')
    .values({
      name: input.name,
      library_ids: [...new Set(input.library_ids)],
      default_library_id: input.default_library_id,
      default_section_key: sectionKey,
      allowed_origins: helpinatorNormalizeOrigins(input.allowed_origins),
      daily_message_cap: input.daily_message_cap,
      enabled: input.enabled,
      appearance: sql`${JSON.stringify(helpinatorAppearanceOverrides(input.appearance))}::text::jsonb`,
      extra_instructions: input.extra_instructions.trim(),
      starter_questions: helpinatorNormalizeStarterQuestions(input.starter_questions),
      created_by: userId
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function helpinatorUpdateWidget(
  tx: Tx,
  id: string,
  input: HelpinatorWidgetInputValue
): Promise<HelpinatorWidgetRow> {
  const existing = await helpinatorGetWidgetOr404(tx, id)
  const sectionKey = await assertBinding(tx, input)
  const libraryIds = [...new Set(input.library_ids)]
  const updated = await tx
    .updateTable('helpinator_widgets')
    .set({
      name: input.name,
      library_ids: libraryIds,
      default_library_id: input.default_library_id,
      default_section_key: sectionKey,
      allowed_origins: helpinatorNormalizeOrigins(input.allowed_origins),
      daily_message_cap: input.daily_message_cap,
      enabled: input.enabled,
      appearance: sql`${JSON.stringify(helpinatorAppearanceOverrides(input.appearance))}::text::jsonb`,
      extra_instructions: input.extra_instructions.trim(),
      starter_questions: helpinatorNormalizeStarterQuestions(input.starter_questions),
      updated_at: sql`now()`
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()

  // Rebinding to other libraries ends every open conversation: each was
  // grounded on the old set and must never silently switch.
  if (!helpinatorSameBinding(existing, { library_ids: libraryIds, default_library_id: input.default_library_id })) {
    await tx
      .updateTable('helpinator_conversations')
      .set({ ended_at: sql`now()` })
      .where('widget_id', '=', id)
      .where('ended_at', 'is', null)
      .execute()
  }
  return updated
}

export async function helpinatorDeleteWidget(tx: Tx, id: string): Promise<void> {
  if (!HELPINATOR_UUID_RE.test(id)) throw createError({ statusCode: 404, statusMessage: 'Widget not found' })
  const res = await tx.deleteFrom('helpinator_widgets').where('id', '=', id).executeTakeFirst()
  if (!res.numDeletedRows) throw createError({ statusCode: 404, statusMessage: 'Widget not found' })
}

export interface HelpinatorPublicConfig {
  id: string
  appearance: Required<HelpinatorAppearance>
  // Offered as clickable chips until the visitor sends a message.
  starterQuestions: string[]
  // False when the widget is disabled, has no libraries, or AI isn't
  // configured — the widget then shows a short "unavailable" state instead of
  // the chat.
  aiAvailable: boolean
  // Whether "still need help?" is offered (inbox layer loaded).
  handoffAvailable: boolean
}

export function helpinatorPublicConfig(
  widget: HelpinatorWidgetRow,
  flags: { aiConfigured: boolean, handoffAvailable: boolean }
): HelpinatorPublicConfig {
  return {
    id: widget.id,
    appearance: helpinatorResolvedAppearance(widget.appearance),
    starterQuestions: widget.starter_questions,
    aiAvailable: widget.enabled && widget.library_ids.length > 0 && flags.aiConfigured,
    handoffAvailable: flags.handoffAvailable
  }
}
