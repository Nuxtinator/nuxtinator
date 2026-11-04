// Code-owned portfolio templates: the sections a portfolio is created with.
// `default` is the catalog in `section-catalog.ts`; other layers register theirs.

import { CONTEXT_SECTIONS, slugifySectionTitle, type SectionDef } from './section-catalog'

export interface PortfolioTemplate {
  id: string
  label: string
  description?: string
  sections: readonly SectionDef[]
}

export const DEFAULT_PORTFOLIO_TEMPLATE_ID = 'default'

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Stored frozen so a caller holding a returned template can't change it for
// every request.
function freezeTemplate(template: PortfolioTemplate): PortfolioTemplate {
  return Object.freeze({
    ...template,
    sections: Object.freeze(template.sections.map(s => Object.freeze({ ...s })))
  })
}

const _templates = new Map<string, PortfolioTemplate>([
  [DEFAULT_PORTFOLIO_TEMPLATE_ID, freezeTemplate({
    id: DEFAULT_PORTFOLIO_TEMPLATE_ID,
    label: 'Organization',
    description: 'Identity, vision, team, goals, and the other sections that describe an organization.',
    sections: CONTEXT_SECTIONS
  })]
])

// Throws on an invalid or duplicate registration so a broken template fails
// the boot instead of resolving wrong titles later.
export function registerPortfolioTemplate(template: PortfolioTemplate): void {
  if (!template || typeof template.id !== 'string' || !TEMPLATE_ID_RE.test(template.id)) {
    throw new Error(`[context] portfolio template id must match ${TEMPLATE_ID_RE} (got ${JSON.stringify(template?.id)})`)
  }
  if (_templates.has(template.id)) {
    throw new Error(`[context] portfolio template "${template.id}" is already registered`)
  }
  if (typeof template.label !== 'string' || template.label.length === 0) {
    throw new Error(`[context] portfolio template "${template.id}" needs a label`)
  }

  if (!Array.isArray(template.sections)) {
    throw new Error(`[context] portfolio template "${template.id}" needs a sections array`)
  }

  const seen = new Set<string>()
  for (const s of template.sections) {
    if (typeof s?.key !== 'string' || s.key.length === 0 || slugifySectionTitle(s.key) !== s.key) {
      throw new Error(`[context] portfolio template "${template.id}" has an invalid section key ${JSON.stringify(s?.key)} (lowercase letters, digits, and hyphens, at most 64)`)
    }
    if (seen.has(s.key)) {
      throw new Error(`[context] portfolio template "${template.id}" declares section "${s.key}" more than once`)
    }
    seen.add(s.key)
    if (typeof s.title !== 'string' || s.title.length === 0) {
      throw new Error(`[context] portfolio template "${template.id}" section "${s.key}" needs a title`)
    }
    if (typeof s.description !== 'string') {
      throw new Error(`[context] portfolio template "${template.id}" section "${s.key}" needs a description string`)
    }
    if (!Number.isFinite(s.order)) {
      throw new Error(`[context] portfolio template "${template.id}" section "${s.key}" needs a numeric order`)
    }
    if (!Number.isInteger(s.staleness_days) || s.staleness_days <= 0) {
      throw new Error(`[context] portfolio template "${template.id}" section "${s.key}" needs a positive integer staleness_days`)
    }
  }

  _templates.set(template.id, freezeTemplate(template))
}

export function getRegisteredPortfolioTemplates(): PortfolioTemplate[] {
  return [..._templates.values()]
}

// `null`/`undefined` is the default template.
export function getRegisteredPortfolioTemplate(id: string | null | undefined): PortfolioTemplate | null {
  return _templates.get(id ?? DEFAULT_PORTFOLIO_TEMPLATE_ID) ?? null
}
