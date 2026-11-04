// Built-in section definitions for a context portfolio. The keys, titles,
// descriptions, and order match the org-section catalog from the source
// FastAPI app (`sections.py` ORG_SECTIONS).

export interface SectionDef {
  key: string
  title: string
  description: string
  order: number
  staleness_days: number
}

export const CONTEXT_SECTIONS: readonly SectionDef[] = [
  {
    key: 'identity',
    title: 'Identity',
    description: 'What the organization is — name, origin, positioning',
    order: 1,
    staleness_days: 60
  },
  {
    key: 'vision-and-values',
    title: 'Vision & Values',
    description: 'Why the organization exists — mission and guiding beliefs',
    order: 2,
    staleness_days: 60
  },
  {
    key: 'team',
    title: 'Team',
    description: 'Leadership, staff, and key roles within the organization — roles and initials for private individuals',
    order: 3,
    staleness_days: 60
  },
  {
    key: 'goals-and-priorities',
    title: 'Goals & Priorities',
    description: 'What the organization is working toward',
    order: 4,
    staleness_days: 30
  },
  {
    key: 'communication-style',
    title: 'Communication Style',
    description: 'How the organization speaks — voice, tone, audience',
    order: 5,
    staleness_days: 60
  },
  {
    key: 'personas',
    title: 'Personas',
    description: 'Target audience personas — demographics, needs, and how to address them',
    order: 6,
    staleness_days: 60
  },
  {
    key: 'tools-and-systems',
    title: 'Tools & Systems',
    description: 'What the organization runs on — stack and workflows',
    order: 7,
    staleness_days: 60
  },
  {
    key: 'translation',
    title: 'Translation',
    description: 'How projects are localized — languages, workflows, and tools per project',
    order: 8,
    staleness_days: 60
  },
  {
    key: 'decision-log',
    title: 'Decision Log',
    description: 'Key decisions, pivots, and the reasoning behind them',
    order: 9,
    staleness_days: 60
  }
] as const

export function slugifySectionTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
