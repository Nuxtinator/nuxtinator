// `#context/server`: the layer's semver-covered public server API. Kept out of
// server/utils/ so nitro's auto-import scan doesn't double-import these names.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TeamScope } from '#core/server/utils/team-access'
import type { createSuggestionSet, decideSuggestions, pendingForSection } from '../utils/suggestions'
import {
  getPortfolioById as portfolioById,
  getPortfolioBySlug as portfolioBySlug,
  getPortfolioBySlugOr404 as portfolioBySlugOr404,
  listPortfolios as allPortfolios,
  type PortfolioRow
} from '../utils/portfolio-helpers'

export { createPortfolio, getContextTeamScope } from '../utils/portfolio-helpers'
export type { PortfolioRow, CreatePortfolioInput } from '../utils/portfolio-helpers'

// Portfolio lookups. With the caller's `scope` (`getContextTeamScope`) they
// leave out portfolios limited to teams the caller isn't on; without one they
// are unfiltered, for paths with no user only (jobs, public bots).
export async function getPortfolioById(tx: Transaction<Database>, id: string, scope?: TeamScope): Promise<PortfolioRow | null> {
  return await portfolioById(tx, id, scope ?? null)
}

export async function getPortfolioBySlug(tx: Transaction<Database>, slug: string, scope?: TeamScope): Promise<PortfolioRow | null> {
  return await portfolioBySlug(tx, slug, scope ?? null)
}

export async function getPortfolioBySlugOr404(tx: Transaction<Database>, slug: string, scope?: TeamScope): Promise<PortfolioRow> {
  return await portfolioBySlugOr404(tx, slug, scope ?? null)
}

export async function listPortfolios(tx: Transaction<Database>, scope?: TeamScope): Promise<PortfolioRow[]> {
  return await allPortfolios(tx, scope ?? null)
}

// Everything below takes a portfolio (or its id) or a suggestion set and
// doesn't check teams: look the portfolio up with the caller's scope first.

export { getPortfolioSections } from '../utils/section-settings'
export type { MergedSection, PortfolioRef } from '../utils/section-settings'

export { loadSection, saveSectionContent, addSection } from '../utils/section-helpers'
export type { SectionRow, SaveSectionOptions, AddSectionInput } from '../utils/section-helpers'

export type { SectionDef } from '../utils/section-catalog'
export type { ContextSectionVersionSource, ContextSuggestionStatus } from '../database/schema'

export {
  createSuggestionSet,
  decideSuggestions,
  withdrawSuggestions,
  pendingForSection
} from '../utils/suggestions'
export type { NewSuggestion, SuggestionViewer } from '../utils/suggestions'
export type CreatedSuggestionSet = Awaited<ReturnType<typeof createSuggestionSet>>
export type DecidedSuggestion = Awaited<ReturnType<typeof decideSuggestions>>[number]
export type SectionPendingSuggestions = Awaited<ReturnType<typeof pendingForSection>>

export {
  registerPortfolioTemplate,
  getRegisteredPortfolioTemplate,
  getRegisteredPortfolioTemplates,
  DEFAULT_PORTFOLIO_TEMPLATE_ID
} from '../utils/portfolio-template-registry'
export type { PortfolioTemplate } from '../utils/portfolio-template-registry'
