// Portfolio section list. Every section a portfolio has is a row in
// `context_section_definitions`; this reads those rows and fills in the
// code-owned defaults for built-in rows (title, description, order, and
// staleness from the portfolio's template in `portfolio-template-registry.ts`).
// A custom row carries its own title/description.
//
// Not built on `defineSettings`: that helper is registry-first (code decides
// what exists, the DB only overrides). Here the portfolio's rows decide what
// exists — the template only supplies the defaults for the keys it declares.

import type { DbClient } from '#core/server/utils/settings'
import type { SectionDef } from './section-catalog'
import { getRegisteredPortfolioTemplate } from './portfolio-template-registry'

export interface MergedSection extends SectionDef {
  id: string
  is_custom: boolean
}

// A portfolio id, or a portfolio row already in hand (which saves the
// template lookup).
export type PortfolioRef = string | { id: string, template: string | null }

const warnedTemplates = new Set<string>()

// The sections a template declares. A template id that is no longer
// registered declares none, so its keys read as orphans.
export function getTemplateSections(templateId: string | null | undefined): readonly SectionDef[] {
  const template = getRegisteredPortfolioTemplate(templateId)
  if (!template && templateId && !warnedTemplates.has(templateId)) {
    warnedTemplates.add(templateId)
    console.warn(`[context] portfolio template "${templateId}" is not registered; its sections resolve as orphans`)
  }
  return template?.sections ?? []
}

export function portfolioIdOf(portfolio: PortfolioRef): string {
  return typeof portfolio === 'string' ? portfolio : portfolio.id
}

export async function getPortfolioTemplateSections(
  tx: DbClient,
  portfolio: PortfolioRef
): Promise<readonly SectionDef[]> {
  if (typeof portfolio !== 'string') return getTemplateSections(portfolio.template)
  const row = await tx
    .selectFrom('context_portfolios')
    .select('template')
    .where('id', '=', portfolio)
    .executeTakeFirst()
  return getTemplateSections(row?.template)
}

// A stored `order` is the section's absolute position, whatever kind of
// section it is, so a custom section can sit between two built-ins. With no
// stored position a built-in sits where its template puts it and a custom
// sits past the template's last section.
function resolveOrder(builtins: readonly SectionDef[], key: string, isCustom: boolean, order: number | null): number {
  if (order !== null) return order
  return (isCustom ? undefined : builtins.find(s => s.key === key)?.order)
    ?? Math.max(0, ...builtins.map(s => s.order)) + 1
}

export async function getPortfolioSections(
  tx: DbClient,
  portfolio: PortfolioRef
): Promise<MergedSection[]> {
  return await mergePortfolioSections(tx, portfolioIdOf(portfolio), await getPortfolioTemplateSections(tx, portfolio))
}

// A row created as custom stays custom even if its template later declares
// the same key; a built-in row whose key the template no longer declares
// reads as custom (an orphan).
export async function mergePortfolioSections(
  tx: DbClient,
  portfolioId: string,
  builtins: readonly SectionDef[]
): Promise<MergedSection[]> {
  const rows = await tx
    .selectFrom('context_section_definitions')
    .select(['id', 'key', 'title', 'description', 'order', 'is_custom'])
    .where('portfolio_id', '=', portfolioId)
    .orderBy('created_at')
    .orderBy('key')
    .execute()

  return rows
    .map((row) => {
      const t = row.is_custom ? undefined : builtins.find(s => s.key === row.key)
      return {
        id: row.id,
        key: row.key,
        title: row.title ?? t?.title ?? row.key,
        description: row.description ?? t?.description ?? '',
        order: resolveOrder(builtins, row.key, row.is_custom, row.order),
        staleness_days: t?.staleness_days ?? 60,
        is_custom: !t
      }
    })
    // Stable, so sections sharing a position stay in creation order.
    .sort((a, b) => a.order - b.order)
}

// Where a section added now should sit. A portfolio the user has ordered
// explicitly keeps new sections at the end; one still on template order stores
// no position at all and resolves from code.
export async function nextExplicitOrder(
  tx: DbClient,
  portfolioId: string,
  builtins: readonly SectionDef[]
): Promise<number | undefined> {
  const rows = await tx
    .selectFrom('context_section_definitions')
    .select(['key', 'order', 'is_custom'])
    .where('portfolio_id', '=', portfolioId)
    .execute()

  if (!rows.some(r => r.order !== null)) return undefined
  return Math.max(0, ...rows.map(r => resolveOrder(builtins, r.key, r.is_custom, r.order))) + 1
}
