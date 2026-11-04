// Markdown export formatters. Used by single-section and full-portfolio
// download routes plus the future MCP `read_organization` tool. Section
// markdown is `# {title}\n\n{content}`; the README is a hand-written index
// listing every section file with its description.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { PortfolioRow } from './portfolio-helpers'
import { getPortfolioSections, type MergedSection } from './section-settings'

export interface SectionExportFile {
  filename: string
  content: string
}

export function formatSectionMarkdown(title: string, content: string): string {
  return `# ${title}\n\n${content || ''}`
}

export function buildReadme(p: PortfolioRow, defs: MergedSection[]): string {
  const list = defs
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(d => `- \`${d.key}.md\` — ${d.description}`)
    .join('\n')

  const today = new Date().toISOString().slice(0, 10)
  return `# ${p.name}

This is a context portfolio export — a structured set of markdown files designed to be read by AI tools, agents, and assistants.

## Files

${list}

## Usage

Drop these files into a Claude Project, expose them as MCP resources, or include them in any AI tool's context. They work anywhere markdown is understood.

These are living documents. Update them as your context changes.

*Exported from Context Portfolio on ${today}*
`
}

// Build the full set of markdown files (sections + README) for a portfolio.
// The caller (zip route) packs the result; the README is always last.
export async function buildPortfolioExport(
  tx: Transaction<Database>,
  p: PortfolioRow
): Promise<{ files: SectionExportFile[], readme: string, safeFilename: string }> {
  const defs = await getPortfolioSections(tx, p)
  const rows = await tx
    .selectFrom('context_sections')
    .select(['section_key', 'content'])
    .where('portfolio_id', '=', p.id)
    .execute()
  const byKey = new Map(rows.map(r => [r.section_key as string, r.content as string]))

  const files: SectionExportFile[] = []
  for (const d of defs) {
    const content = byKey.get(d.key) ?? ''
    files.push({
      filename: `${d.key}.md`,
      content: formatSectionMarkdown(d.title, content)
    })
  }

  const readme = buildReadme(p, defs)
  const rawName = (p.name || 'portfolio').toLowerCase().replace(/\s+/g, '-')
  const safeFilename = rawName.replace(/[^a-z0-9._-]/g, '') || 'portfolio'

  return { files, readme, safeFilename }
}
