// Assistant prompt builder, loading tools, and section-update parser.
//
// A conversation runs in one of three scopes. The scope decides what the
// system prompt preloads and which loading tools the model gets:
//   section   — the one section is loaded; `load_section` / `load_portfolio`
//               pull in the rest of that portfolio on demand.
//   portfolio — every non-empty section of the portfolio is loaded; no tools.
//   all       — an index of every portfolio is listed; `load_portfolio` /
//               `load_section` fetch content on demand.
// Proposed edits come back as fenced `section-update` blocks that name the
// portfolio and section; the parser validates both against the scope.

import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TeamScope } from '#core/server/utils/team-access'
import { aiUsageSubject, type AiDbClient, type AiTool, type AiToolHandler, type AiMessage, type AiTextPart } from '#ai/server'
import { listPortfolios, type PortfolioRow } from './portfolio-helpers'
import { getPortfolioSections, type MergedSection } from './section-settings'
import { searchSections, type SectionSearchHit } from './section-index'
import type { ContextAssistantProposal } from '../database/schema'
import type { ConversationRow, MessageRow } from './assistant-conversations'

type Tx = Transaction<Database>

// The `#ai/server` feature key; the admin AI page shows a model picker for it.
export const CONTEXT_ASSISTANT_FEATURE = 'context.assistant'

// The assistant's spend is logged per portfolio as `context-portfolio:<id>`,
// or `context-portfolio:all` for chats about every portfolio; the AI spend
// page names those ids through `contextPortfolioNames`.
export const CONTEXT_PORTFOLIO_SUBJECT = 'context-portfolio'
const ALL_PORTFOLIOS = 'all'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function contextAssistantSubject(portfolioId: string | null): string {
  return aiUsageSubject(CONTEXT_PORTFOLIO_SUBJECT, portfolioId ?? ALL_PORTFOLIOS)
}

export async function contextPortfolioNames(tx: AiDbClient, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (ids.includes(ALL_PORTFOLIOS)) names.set(ALL_PORTFOLIOS, 'All portfolios')
  const valid = ids.filter(id => UUID_RE.test(id))
  if (!valid.length) return names
  const rows = await tx.selectFrom('context_portfolios').select(['id', 'name']).where('id', 'in', valid).execute()
  for (const r of rows) names.set(r.id, r.name)
  return names
}

export type AssistantScope =
  | { kind: 'section', portfolio: PortfolioRow, sectionKey: string }
  | { kind: 'portfolio', portfolio: PortfolioRow }
  | { kind: 'all' }

export type ProposalDraft = Omit<ContextAssistantProposal, 'status'>

export interface AssistantContext {
  system: AiTextPart[]
  tools: AiTool[]
  onToolCall: AiToolHandler
  // Human labels of everything the model has read, in load order.
  contextLoaded: string[]
  // Ids of the portfolios whose content reached the model this turn.
  portfoliosUsed: Set<string>
  parseProposals: (reply: string) => ProposalDraft[]
  // What a tool call would read, for progress display: 'Team', 'Acme › Team'
  // in the all scope, or 'all of Acme'. Null when it would load nothing.
  describeToolCall: (name: string, input: Record<string, unknown>) => string | null
}

interface PortfolioEntry {
  portfolio: PortfolioRow
  sections: MergedSection[]
  // Every stored section body, keyed by section key. Empty bodies are absent.
  content: Map<string, string>
  // Keys whose content is in the prompt or has been loaded by a tool.
  loaded: Set<string>
}

// Most recent messages sent to the model as history.
export const HISTORY_LIMIT = 30

export function scopeFromConversation(
  conversation: ConversationRow,
  portfolio: PortfolioRow | null
): AssistantScope {
  if (conversation.portfolio_id && portfolio) {
    return conversation.section_key
      ? { kind: 'section', portfolio, sectionKey: conversation.section_key }
      : { kind: 'portfolio', portfolio }
  }
  return { kind: 'all' }
}

export function historyToMessages(messages: MessageRow[]): AiMessage[] {
  const recent = messages.slice(-HISTORY_LIMIT)
  // The newest stored turn carries a cache breakpoint so the next turn reads
  // the whole history from cache rather than only the system prompt. An empty
  // turn (a reply that was only update blocks) stays a plain string, since an
  // empty text block is rejected upstream.
  return recent.map((m, i): AiMessage => ({
    role: m.role,
    content: i === recent.length - 1 && m.content ? [{ type: 'text', text: m.content, cache: true }] : m.content
  }))
}

function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

async function loadPortfolioEntries(tx: Tx, scope: AssistantScope, teamScope: TeamScope): Promise<PortfolioEntry[]> {
  const portfolios: PortfolioRow[] = scope.kind === 'all'
    ? await listPortfolios(tx, teamScope)
    : [scope.portfolio]
  if (portfolios.length === 0) return []

  const rows = await tx
    .selectFrom('context_sections')
    .select(['portfolio_id', 'section_key', 'content'])
    .where('portfolio_id', 'in', portfolios.map(p => p.id))
    .execute()

  const entries: PortfolioEntry[] = []
  for (const portfolio of portfolios) {
    const content = new Map<string, string>()
    for (const r of rows) {
      if (r.portfolio_id === portfolio.id && typeof r.content === 'string' && r.content.trim().length > 0) {
        content.set(r.section_key, r.content)
      }
    }
    entries.push({
      portfolio,
      sections: await getPortfolioSections(tx, portfolio),
      content,
      loaded: new Set()
    })
  }
  return entries
}

const CAPABILITIES = `## Your capabilities:
- Answer questions based on portfolio section content
- Help draft content (emails, messages, documents) using portfolio context
- Suggest updates to portfolio sections when the user provides new information
- Reword, restructure, or refine existing section content on request`

const UPDATE_FORMAT = `## Section update format:
When you determine that one or more sections should be updated, include proposed changes in your response using this exact format (one block per section):

\`\`\`section-update
PORTFOLIO: <portfolio_slug>
SECTION_KEY: <section_key>
SECTION_TITLE: <section_title>
---
<full proposed content for the section>
\`\`\`

Only propose updates when the user's message contains information that should be captured, or when they explicitly ask to modify content. Always explain what you're changing and why before the update blocks.`

const MUST_LOAD = 'Before proposing an update to a section whose content you have NOT yet seen, you MUST load it first. Never blindly overwrite a section.'

const EDIT_NOTICE_CAN_EDIT = 'The user has edit access. They can accept or reject each proposed update individually.'
const EDIT_NOTICE_VIEWER = 'The user has view-only access. You can help them draft content and answer questions, but they cannot save changes to sections. Do NOT propose section updates.'

interface ToolCaps {
  loadSection: number
  loadPortfolio: number
  search: number
}

// The portfolio scope preloads everything, so it gets neither loaders nor
// search; the other two search the vector index (section-index.ts).
function toolCapsFor(scope: AssistantScope): ToolCaps {
  if (scope.kind === 'section') return { loadSection: 3, loadPortfolio: 1, search: 2 }
  if (scope.kind === 'all') return { loadSection: 5, loadPortfolio: 3, search: 2 }
  return { loadSection: 0, loadPortfolio: 0, search: 0 }
}

// Hits returned to the model, per search and per auto-search.
export const SEARCH_HITS = 8

function scopeIntro(scope: AssistantScope, entries: PortfolioEntry[]): string {
  if (scope.kind === 'section') {
    const title = entries[0]?.sections.find(s => s.key === scope.sectionKey)?.title ?? scope.sectionKey
    return `You are focused on the "${title}" section of the portfolio "${scope.portfolio.name}". The rest of that portfolio is available on request.`
  }
  if (scope.kind === 'portfolio') {
    return `You have the full content of the portfolio "${scope.portfolio.name}".`
  }
  const names = entries.map(e => `"${e.portfolio.name}"`).join(', ')
  return `You have access to every portfolio in this workspace${names ? `: ${names}` : ''}. Each portfolio describes one organization, team, or initiative.`
}

const SEARCH_NOTICE = 'Each user message is also searched against every section automatically and the best matches are listed under "Search hits"; use `search_sections` with a rephrased query when those miss, then load the matching section.'

function loadingNotice(scope: AssistantScope, caps: ToolCaps): string {
  if (scope.kind === 'section') {
    return `The current section is loaded below. Use \`load_section\` to read another section of this portfolio (up to ${caps.loadSection} per turn) or \`load_portfolio\` to read all of it (up to ${caps.loadPortfolio} per turn). ${SEARCH_NOTICE} ${MUST_LOAD}`
  }
  if (scope.kind === 'portfolio') {
    return 'Every section with content is loaded below. Sections listed without content are empty.'
  }
  return `Nothing is loaded yet. Use \`load_portfolio\` (up to ${caps.loadPortfolio} per turn) to read every section of one portfolio, or \`load_section\` (up to ${caps.loadSection} per turn) for a single section. ${SEARCH_NOTICE} ${MUST_LOAD}`
}

function portfolioLineNotice(scope: AssistantScope): string {
  if (scope.kind === 'all') return 'The PORTFOLIO line is required and must be one of the slugs listed below.'
  return `The PORTFOLIO line is optional; it defaults to "${scope.portfolio.slug}".`
}

function sectionLine(section: MergedSection, entry: PortfolioEntry): string {
  const body = entry.content.get(section.key)
  const size = body ? `${wordCount(body)} words` : 'empty'
  return `- \`${section.key}\`: ${section.title} — ${section.description} (${size})`
}

function sectionIndex(scope: AssistantScope, entries: PortfolioEntry[]): string {
  if (scope.kind !== 'all') {
    const entry = entries[0]
    return entry ? entry.sections.map(s => sectionLine(s, entry)).join('\n') : '(none)'
  }
  if (entries.length === 0) return '(no portfolios yet)'
  return entries
    .map(e => `### ${e.portfolio.name} (slug: \`${e.portfolio.slug}\`)\n${e.sections.map(s => sectionLine(s, e)).join('\n')}`)
    .join('\n\n')
}

function sectionLabel(scope: AssistantScope, entry: PortfolioEntry, key: string): string {
  const title = entry.sections.find(s => s.key === key)?.title ?? key
  return scope.kind === 'all' ? `${entry.portfolio.name} › ${title}` : title
}

function renderLoaded(scope: AssistantScope, entries: PortfolioEntry[]): string {
  const parts: string[] = []
  for (const entry of entries) {
    for (const section of entry.sections) {
      if (!entry.loaded.has(section.key)) continue
      const body = entry.content.get(section.key)
      if (!body) continue
      parts.push(`## ${sectionLabel(scope, entry, section.key)}\n\n${body}`)
    }
  }
  return parts.length ? parts.join('\n\n---\n\n') : '(No sections loaded yet.)'
}

const LOAD_SECTION_TOOL: AiTool = {
  name: 'load_section',
  description: 'Load the full content of one portfolio section. Use it before proposing an update to a section you have not seen.',
  parameters: {
    type: 'object',
    properties: {
      portfolio: { type: 'string', description: 'Portfolio slug. Optional when the conversation is scoped to one portfolio.' },
      section_key: { type: 'string', description: 'The section key, e.g. \'team\' or \'vision-and-values\'.' }
    },
    required: ['section_key']
  }
}

const LOAD_PORTFOLIO_TOOL: AiTool = {
  name: 'load_portfolio',
  description: 'Load every section of one portfolio at once. Use it when you need broad context.',
  parameters: {
    type: 'object',
    properties: {
      portfolio: { type: 'string', description: 'Portfolio slug. Optional when the conversation is scoped to one portfolio.' }
    }
  }
}

const SEARCH_SECTIONS_TOOL: AiTool = {
  name: 'search_sections',
  description: 'Find the sections most relevant to a query, across every portfolio available in this conversation. Returns section keys and snippets; load a section to read it in full.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, phrased as a short question or topic.' }
    },
    required: ['query'],
    additionalProperties: false
  }
}

function renderHits(scope: AssistantScope, entries: PortfolioEntry[], hits: SectionSearchHit[]): string {
  if (hits.length === 0) return '(no matches)'
  const byId = new Map(entries.map(e => [e.portfolio.id, e]))
  return hits.map((h) => {
    const entry = byId.get(h.portfolio_id)
    const label = entry ? sectionLabel(scope, entry, h.section_key) : h.section_key
    const where = scope.kind === 'all' && entry ? ` (portfolio \`${entry.portfolio.slug}\`)` : ''
    const snippet = h.snippet.replace(/\s+/g, ' ').trim().slice(0, 200)
    return `- \`${h.section_key}\`${where}: ${label}${h.heading ? ` › ${h.heading}` : ''} — ${snippet}`
  }).join('\n')
}

// `teamScope` is the caller's: the all scope lists, and search reaches, only
// the portfolios their teams can see.
export async function buildAssistantContext(
  tx: Tx,
  scope: AssistantScope,
  userCanEdit: boolean,
  teamScope: TeamScope,
  opts: { userMessage?: string } = {}
): Promise<AssistantContext> {
  const entries = await loadPortfolioEntries(tx, scope, teamScope)
  const bySlug = new Map(entries.map(e => [e.portfolio.slug, e]))
  const scopedSlug = scope.kind === 'all' ? null : scope.portfolio.slug
  const contextLoaded: string[] = []
  const portfoliosUsed = new Set<string>()
  const portfolioIds = entries.map(e => e.portfolio.id)

  // Preload per scope. Only sections with content count as loaded, so an
  // empty section stays loadable (and reports as empty when asked for).
  for (const entry of entries) {
    const visible = new Set(entry.sections.map(s => s.key))
    const keys = scope.kind === 'portfolio'
      ? [...visible]
      : scope.kind === 'section' ? [scope.sectionKey] : []
    for (const key of keys) {
      if (visible.has(key) && entry.content.has(key)) {
        entry.loaded.add(key)
        contextLoaded.push(sectionLabel(scope, entry, key))
        portfoliosUsed.add(entry.portfolio.id)
      }
    }
  }

  const caps = toolCapsFor(scope)
  const tools: AiTool[] = caps.loadSection > 0 ? [LOAD_SECTION_TOOL, LOAD_PORTFOLIO_TOOL] : []
  if (caps.search > 0) tools.push(SEARCH_SECTIONS_TOOL)

  // Auto-search: the user's latest message against the index, injected as a
  // second, NON-cached system part so the cached prefix above stays
  // byte-stable. Silent when embeddings are not configured.
  let autoHits: SectionSearchHit[] = []
  if (caps.search > 0 && opts.userMessage?.trim()) {
    try {
      autoHits = await searchSections(tx, { portfolioIds, query: opts.userMessage, limit: SEARCH_HITS, teamScope })
      for (const h of autoHits) portfoliosUsed.add(h.portfolio_id)
    } catch (err) {
      console.error('[context] assistant auto-search failed:', (err as Error)?.message ?? err)
    }
  }

  // One cacheable part: the prompt is byte-stable across the tool rounds of a
  // turn and across turns until a section changes, so caching-capable models
  // read it from cache after the first call.
  const system: AiTextPart[] = [{
    type: 'text',
    text: [
      'You are an AI assistant for Context Portfolio, helping users manage organizational knowledge.',
      scopeIntro(scope, entries),
      CAPABILITIES,
      `## Loading additional context:\n${loadingNotice(scope, caps)}`,
      `${UPDATE_FORMAT}\n\n${portfolioLineNotice(scope)}`,
      userCanEdit ? EDIT_NOTICE_CAN_EDIT : EDIT_NOTICE_VIEWER,
      `## Available sections:\n${sectionIndex(scope, entries)}`,
      `## Loaded context:\n${renderLoaded(scope, entries)}`
    ].join('\n\n'),
    cache: true
  }]
  if (caps.search > 0 && opts.userMessage?.trim()) {
    system.push({
      type: 'text',
      text: `## Search hits for the latest message:\n${renderHits(scope, entries, autoHits)}`
    })
  }

  let sectionLoads = 0
  let portfolioLoads = 0
  let searches = 0

  function resolveEntry(input: Record<string, unknown>): PortfolioEntry | string {
    const raw = typeof input.portfolio === 'string' ? input.portfolio.trim() : ''
    const slug = raw || scopedSlug
    if (!slug) return 'Error: a portfolio slug is required in this conversation.'
    if (scopedSlug && slug !== scopedSlug) return `Error: this conversation is scoped to portfolio '${scopedSlug}'.`
    const entry = bySlug.get(slug)
    return entry ?? `Error: unknown portfolio '${slug}'.`
  }

  function loadOne(entry: PortfolioEntry, key: string): string {
    const body = entry.content.get(key)
    if (!body) return `Section '${key}' of '${entry.portfolio.slug}' exists but has no content yet.`
    if (!entry.loaded.has(key)) {
      entry.loaded.add(key)
      contextLoaded.push(sectionLabel(scope, entry, key))
    }
    portfoliosUsed.add(entry.portfolio.id)
    return `## ${sectionLabel(scope, entry, key)}\n\n${body}`
  }

  const onToolCall: AiToolHandler = async (name, input) => {
    if (name === 'search_sections') {
      if (searches >= caps.search) return `Error: search_sections limit reached (max ${caps.search} per turn).`
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (!query) return 'Error: a query is required.'
      searches++
      try {
        const hits = await searchSections(tx, { portfolioIds, query, limit: SEARCH_HITS, teamScope })
        for (const h of hits) portfoliosUsed.add(h.portfolio_id)
        return `## Search hits for "${query}":\n${renderHits(scope, entries, hits)}`
      } catch (err) {
        return `Error: search is unavailable right now (${(err as { statusMessage?: string })?.statusMessage ?? 'embedding failed'}).`
      }
    }
    if (name === 'load_section') {
      if (sectionLoads >= caps.loadSection) return `Error: load_section limit reached (max ${caps.loadSection} per turn).`
      const entry = resolveEntry(input)
      if (typeof entry === 'string') return entry
      const key = typeof input.section_key === 'string' ? input.section_key.trim() : ''
      if (!entry.sections.some(s => s.key === key)) return `Error: unknown section key '${key}' in portfolio '${entry.portfolio.slug}'.`
      if (entry.loaded.has(key)) return `Section '${key}' is already loaded in your context.`
      sectionLoads++
      return loadOne(entry, key)
    }
    if (name === 'load_portfolio') {
      if (portfolioLoads >= caps.loadPortfolio) return `Error: load_portfolio limit reached (max ${caps.loadPortfolio} per turn).`
      const entry = resolveEntry(input)
      if (typeof entry === 'string') return entry
      portfolioLoads++
      const parts = entry.sections
        .filter(s => entry.content.has(s.key))
        .map(s => loadOne(entry, s.key))
      return parts.length ? parts.join('\n\n---\n\n') : `Portfolio '${entry.portfolio.slug}' has no sections with content yet.`
    }
    return `Error: unknown tool '${name}'.`
  }

  function describeToolCall(name: string, input: Record<string, unknown>): string | null {
    if (name === 'search_sections') {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      return query ? `search results for "${query.slice(0, 60)}"` : null
    }
    const entry = resolveEntry(input)
    if (typeof entry === 'string') return null
    if (name === 'load_portfolio') return `all of ${entry.portfolio.name}`
    if (name === 'load_section') {
      const key = typeof input.section_key === 'string' ? input.section_key.trim() : ''
      return entry.sections.some(s => s.key === key) ? sectionLabel(scope, entry, key) : null
    }
    return null
  }

  function parseProposals(reply: string): ProposalDraft[] {
    const out: ProposalDraft[] = []
    const re = new RegExp(SECTION_UPDATE_PATTERN.source, SECTION_UPDATE_PATTERN.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(reply))) {
      const slug = (m[1] ?? '').trim() || scopedSlug
      const key = (m[2] ?? '').trim()
      const content = (m[4] ?? '').trim()
      const entry = slug ? bySlug.get(slug) : undefined
      const def = entry?.sections.find(s => s.key === key)
      if (!entry || !def) continue
      portfoliosUsed.add(entry.portfolio.id)
      out.push({
        portfolio_slug: entry.portfolio.slug,
        portfolio_name: entry.portfolio.name,
        section_key: key,
        section_title: def.title,
        current_content: entry.content.get(key) ?? '',
        proposed_content: content
      })
    }
    return out
  }

  return { system, tools, onToolCall, contextLoaded, portfoliosUsed, parseProposals, describeToolCall }
}

const SECTION_UPDATE_PATTERN = /```\s*section-update\s*\r?\n(?:\s*PORTFOLIO:\s*(.+?)\s*\r?\n)?\s*SECTION_KEY:\s*(.+?)\s*\r?\n\s*SECTION_TITLE:\s*(.+?)\s*\r?\n\s*---\s*\r?\n([\s\S]*?)```/g

export function stripUpdateBlocks(reply: string): string {
  return reply.replace(new RegExp(SECTION_UPDATE_PATTERN.source, SECTION_UPDATE_PATTERN.flags), '').trim()
}
