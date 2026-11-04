// `#context/server`: the layer's semver-covered public server API. Kept out of
// server/utils/ so nitro's auto-import scan doesn't double-import these names.

import type { createSuggestionSet, decideSuggestions, pendingForSection } from '../utils/suggestions'

export {
  createPortfolio,
  getPortfolioById,
  getPortfolioBySlug,
  getPortfolioBySlugOr404,
  listPortfolios
} from '../utils/portfolio-helpers'
export type { PortfolioRow, CreatePortfolioInput } from '../utils/portfolio-helpers'

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
