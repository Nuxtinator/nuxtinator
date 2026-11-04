// Portfolio-scoped lookups and access guards. Used by every route that
// addresses a single portfolio by slug.
//
// The tenant transaction already restricts visibility to the active org (RLS
// in multi mode, no-op in single). Inside it `lookupBySlug` is a plain
// SELECT — no extra `org_id` filter needed.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import {
  DEFAULT_PORTFOLIO_TEMPLATE_ID,
  getRegisteredPortfolioTemplate,
  getRegisteredPortfolioTemplates
} from './portfolio-template-registry'

export interface PortfolioRow {
  id: string
  slug: string
  name: string
  color: string | null
  icon_url: string | null
  // Registered template id; null = the default template.
  template: string | null
  created_at: Date
  updated_at: Date
}

export async function getPortfolioBySlug(
  tx: Transaction<Database>,
  slug: string
): Promise<PortfolioRow | null> {
  const row = await tx
    .selectFrom('context_portfolios')
    .select(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
    .where('slug', '=', slug)
    .executeTakeFirst()
  return (row as PortfolioRow | undefined) ?? null
}

export async function getPortfolioById(
  tx: Transaction<Database>,
  id: string
): Promise<PortfolioRow | null> {
  const row = await tx
    .selectFrom('context_portfolios')
    .select(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
    .where('id', '=', id)
    .executeTakeFirst()
  return (row as PortfolioRow | undefined) ?? null
}

// The org's portfolios in display order: placed ones by their stored
// position, then any never placed, by name.
export async function listPortfolios(tx: Transaction<Database>): Promise<PortfolioRow[]> {
  const rows = await tx
    .selectFrom('context_portfolios')
    .select(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
    .orderBy('order', ob => ob.asc().nullsLast())
    .orderBy('name', 'asc')
    .execute()
  return rows as PortfolioRow[]
}

// Store a full ordering of the org's portfolios. `ids` must list every
// portfolio exactly once.
export async function reorderPortfolios(
  tx: Transaction<Database>,
  ids: string[]
): Promise<PortfolioRow[]> {
  const current = await listPortfolios(tx)
  const currentIds = new Set(current.map(p => p.id))
  const given = new Set(ids)

  if (given.size !== ids.length) {
    throw createError({ statusCode: 400, statusMessage: 'Order lists the same portfolio more than once.' })
  }
  const missing = current.filter(p => !given.has(p.id)).length
  const unknown = ids.filter(id => !currentIds.has(id)).length
  if (missing > 0 || unknown > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Order must list every portfolio exactly once.'
    })
  }

  for (const [index, id] of ids.entries()) {
    await tx
      .updateTable('context_portfolios')
      .set({ order: index + 1 })
      .where('id', '=', id)
      .execute()
  }

  return await listPortfolios(tx)
}

export async function getPortfolioBySlugOr404(
  tx: Transaction<Database>,
  slug: string
): Promise<PortfolioRow> {
  const p = await getPortfolioBySlug(tx, slug)
  if (!p) {
    throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })
  }
  return p
}

// Produce a stable, unique-in-org slug from a free-text name. Falls back to
// `portfolio` if the name doesn't produce any safe characters. The caller is
// responsible for collision-checking against the DB.
export function slugifyPortfolioName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length >= 2 ? base : 'portfolio'
}

export interface CreatePortfolioInput {
  name: string
  color?: string | null
  slug?: string
  // Registered portfolio template id. Omitted = the default template.
  template?: string
  // Section keys from the template the portfolio starts with. Omitted = every
  // template section; [] = none. Sections can be added or removed afterwards.
  builtin_sections?: string[]
}

// Inserts the portfolio and one key-only definition row per chosen template
// section. The template id is stored (null for the default) so the sections'
// titles, descriptions, and order keep resolving from code.
export async function createPortfolio(
  tx: Transaction<Database>,
  input: CreatePortfolioInput,
  userId: string
): Promise<PortfolioRow> {
  const template = getRegisteredPortfolioTemplate(input.template)
  if (!template) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown portfolio template: ${input.template}. Registered templates: ${getRegisteredPortfolioTemplates().map(t => t.id).join(', ')}.`
    })
  }
  const templateKeys = template.sections.map(s => s.key)
  const keys = input.builtin_sections === undefined
    ? templateKeys
    : [...new Set(input.builtin_sections)]
  const unknown = keys.filter(k => !templateKeys.includes(k))
  if (unknown.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown built-in section(s): ${unknown.join(', ')}. Valid keys: ${templateKeys.join(', ')}.`
    })
  }

  const slug = await ensureUniqueSlug(tx, input.slug ?? slugifyPortfolioName(input.name))
  const inserted = await tx
    .insertInto('context_portfolios')
    .values({
      slug,
      name: input.name,
      color: input.color ?? null,
      template: template.id === DEFAULT_PORTFOLIO_TEMPLATE_ID ? null : template.id
    })
    .returning(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
    .executeTakeFirstOrThrow()

  if (keys.length > 0) {
    await tx
      .insertInto('context_section_definitions')
      .values(keys.map(key => ({ portfolio_id: inserted.id, key, created_by: userId })))
      .execute()
  }

  return inserted as PortfolioRow
}

// Static pages under /context/ that a portfolio slug would collide with.
const RESERVED_SLUGS = new Set(['settings', 'suggestions'])

export async function ensureUniqueSlug(
  tx: Transaction<Database>,
  desired: string
): Promise<string> {
  let slug = desired
  let n = 2
  while (true) {
    const existing = RESERVED_SLUGS.has(slug) || await tx
      .selectFrom('context_portfolios')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst()
    if (!existing) return slug
    slug = `${desired}-${n}`
    n++
    if (n > 1000) {
      throw createError({ statusCode: 500, statusMessage: 'Could not generate a unique slug.' })
    }
  }
}
