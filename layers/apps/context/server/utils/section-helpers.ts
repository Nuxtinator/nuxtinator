// Shared logic for section definitions, reads, and writes. Routes and MCP
// tools call `addSection` / `deleteSection` / `saveSectionContent` so key
// validation, size limits, and version writes stay in one place.

import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { ContextSectionVersionSource } from '../database/schema'
import { slugifySectionTitle } from './section-catalog'
import {
  getPortfolioTemplateSections,
  mergePortfolioSections,
  nextExplicitOrder,
  portfolioIdOf,
  type MergedSection,
  type PortfolioRef
} from './section-settings'
import { indexSectionAfterCommit } from './section-index'

export const MAX_SECTION_BYTES = 100 * 1024

export interface SectionRow {
  index_state?: 'none' | 'ok' | 'stale'
  index_error?: string | null
  id: string
  portfolio_id: string
  section_key: string
  content: string
  last_edited_by: string | null
  last_edited_at: Date
}

// A section exists for a portfolio iff it has a definition row.
export async function isKnownSectionKey(
  tx: Transaction<Database>,
  portfolioId: string,
  key: string
): Promise<boolean> {
  const row = await tx
    .selectFrom('context_section_definitions')
    .select('id')
    .where('portfolio_id', '=', portfolioId)
    .where('key', '=', key)
    .executeTakeFirst()
  return !!row
}

export async function requireKnownSection(
  tx: Transaction<Database>,
  portfolioId: string,
  key: string
): Promise<void> {
  if (!(await isKnownSectionKey(tx, portfolioId, key))) {
    throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })
  }
}

// `{ key }` adds a built-in section from the portfolio's template; `{ title }`
// creates a custom section keyed by the slugified title. Custom keys may not
// collide with the template's current keys.
export type AddSectionInput
  = { key: string }
    | { title: string, description?: string, order?: number }

export async function addSection(
  tx: Transaction<Database>,
  portfolio: PortfolioRef,
  input: AddSectionInput,
  userId: string
): Promise<MergedSection> {
  const portfolioId = portfolioIdOf(portfolio)
  const builtins = await getPortfolioTemplateSections(tx, portfolio)
  const builtinKeys = new Set(builtins.map(s => s.key))
  let key: string
  let values: { title?: string, description?: string, is_custom?: true } = {}
  if ('key' in input) {
    if (!builtinKeys.has(input.key)) {
      throw createError({
        statusCode: 400,
        statusMessage: `"${input.key}" is not a built-in section (built-in keys: ${[...builtinKeys].join(', ') || 'none'}). Pass a title to create a custom section.`
      })
    }
    key = input.key
  } else {
    key = slugifySectionTitle(input.title)
    if (!key) throw createError({ statusCode: 400, statusMessage: 'Title must contain at least one alphanumeric character.' })
    if (builtinKeys.has(key)) {
      throw createError({ statusCode: 409, statusMessage: `Key "${key}" collides with a built-in section — add the built-in "${key}" instead.` })
    }
    values = { title: input.title, description: input.description, is_custom: true }
  }

  if (await isKnownSectionKey(tx, portfolioId, key)) {
    throw createError({ statusCode: 409, statusMessage: `Section "${key}" already exists in this portfolio.` })
  }

  // The caller's explicit position, else the end of a portfolio the user has
  // already ordered, else none — the code default places it.
  const order = ('order' in input ? input.order : undefined)
    ?? await nextExplicitOrder(tx, portfolioId, builtins)

  await tx
    .insertInto('context_section_definitions')
    .values({ portfolio_id: portfolioId, key, ...values, order, created_by: userId })
    .execute()

  const sections = await mergePortfolioSections(tx, portfolioId, builtins)
  return sections.find(s => s.key === key)!
}

// Removes the definition row. Content saved under the key stays in
// `context_sections` (with its versions and comments) and resurfaces if a
// section with the same key is added again.
export async function deleteSection(
  tx: Transaction<Database>,
  portfolioId: string,
  key: string
): Promise<{ id: string, is_custom: boolean, content_retained: boolean }> {
  const existing = await tx
    .selectFrom('context_section_definitions')
    .select(['id', 'is_custom'])
    .where('portfolio_id', '=', portfolioId)
    .where('key', '=', key)
    .executeTakeFirst()
  if (!existing) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })

  const content = await loadSection(tx, portfolioId, key)
  await tx
    .deleteFrom('context_section_definitions')
    .where('id', '=', existing.id)
    .execute()

  return {
    id: existing.id,
    is_custom: existing.is_custom,
    content_retained: (content?.content ?? '').trim().length > 0
  }
}

// Stores an explicit position for every section from a full ordering. `keys`
// must list exactly the portfolio's sections once each; a partial or stale
// list is rejected rather than applied, so no section can be dropped out of
// the order by a client working from an old view.
export async function reorderSections(
  tx: Transaction<Database>,
  portfolio: PortfolioRef,
  keys: string[]
): Promise<MergedSection[]> {
  const portfolioId = portfolioIdOf(portfolio)
  const builtins = await getPortfolioTemplateSections(tx, portfolio)
  const current = await mergePortfolioSections(tx, portfolioId, builtins)
  const currentKeys = new Set(current.map(s => s.key))
  const given = new Set(keys)

  if (given.size !== keys.length) {
    throw createError({ statusCode: 400, statusMessage: 'Order lists the same section more than once.' })
  }
  const missing = current.filter(s => !given.has(s.key)).map(s => s.key)
  const unknown = keys.filter(k => !currentKeys.has(k))
  if (missing.length > 0 || unknown.length > 0) {
    const detail = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unknown.length > 0 ? `not in this portfolio: ${unknown.join(', ')}` : ''
    ].filter(Boolean).join('; ')
    throw createError({
      statusCode: 400,
      statusMessage: `Order must list every section in this portfolio exactly once (${detail}).`
    })
  }

  for (const [index, key] of keys.entries()) {
    await tx
      .updateTable('context_section_definitions')
      .set({ order: index + 1, updated_at: sql<Date>`now()` })
      .where('portfolio_id', '=', portfolioId)
      .where('key', '=', key)
      .execute()
  }

  return await mergePortfolioSections(tx, portfolioId, builtins)
}

export async function loadSection(
  tx: Transaction<Database>,
  portfolioId: string,
  key: string
): Promise<SectionRow | null> {
  const row = await tx
    .selectFrom('context_sections')
    .select(['id', 'portfolio_id', 'section_key', 'content', 'last_edited_by', 'last_edited_at', 'index_state', 'index_error'])
    .where('portfolio_id', '=', portfolioId)
    .where('section_key', '=', key)
    .executeTakeFirst()
  return (row as SectionRow | undefined) ?? null
}

export interface SaveSectionOptions {
  // Stamped on the version row so history can show who made the change:
  // 'user' for UI routes, 'assistant' for accepted proposals, 'mcp' for MCP
  // tools, 'suggestion' for approved suggestions.
  source: ContextSectionVersionSource
  // The approved suggestion this version was written from.
  suggestionId?: string
  enforceKeyExists?: boolean
}

// Atomic upsert + version insert in a single transaction. Returns the updated
// section row plus the new version id.
export async function saveSectionContent(
  tx: Transaction<Database>,
  portfolioId: string,
  key: string,
  content: string,
  userId: string,
  opts: SaveSectionOptions
): Promise<{ section: SectionRow, versionId: string }> {
  if (Buffer.byteLength(content, 'utf8') > MAX_SECTION_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Section content exceeds 100KB limit.' })
  }

  if (opts.enforceKeyExists !== false) {
    const known = await isKnownSectionKey(tx, portfolioId, key)
    if (!known) {
      throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })
    }
  }

  const existing = await loadSection(tx, portfolioId, key)

  let section: SectionRow
  if (existing) {
    const updated = await tx
      .updateTable('context_sections')
      .set({
        content,
        last_edited_by: userId,
        last_edited_at: sql<Date>`now()`
      })
      .where('id', '=', existing.id)
      .returning(['id', 'portfolio_id', 'section_key', 'content', 'last_edited_by', 'last_edited_at'])
      .executeTakeFirstOrThrow()
    section = updated as SectionRow
  } else {
    const inserted = await tx
      .insertInto('context_sections')
      .values({
        portfolio_id: portfolioId,
        section_key: key,
        content,
        last_edited_by: userId
      })
      .returning(['id', 'portfolio_id', 'section_key', 'content', 'last_edited_by', 'last_edited_at'])
      .executeTakeFirstOrThrow()
    section = inserted as SectionRow
  }

  const version = await tx
    .insertInto('context_section_versions')
    .values({
      section_id: section.id,
      content,
      edited_by: userId,
      source: opts.source,
      suggestion_id: opts.suggestionId ?? null
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Keep the vector index in step with the content. Best-effort: a failure
  // marks the section stale and never fails the save. Runs after the save
  // commits, so the embedding call never holds the request's transaction.
  await indexSectionAfterCommit(tx, section.id)

  return { section, versionId: version.id }
}
