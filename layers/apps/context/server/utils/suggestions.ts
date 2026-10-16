// Suggested section updates. MCP update calls create a suggestion set (one
// per call) instead of writing the section; a reviewer approves or rejects
// each suggestion, and an approval writes the section through
// `saveSectionContent` as a version stamped `suggestion`, authored by the
// suggester. Each suggestion keeps the content it was based on, so review
// can flag a section that changed after it was suggested.

import { sql, type Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { Permission } from '#core/app/utils/permissions'
import { getRolePermissions } from '#core/server/utils/rbac'
import { createNotification } from '#core/server/utils/notifications'
import type { ContextSuggestionStatus } from '../database/schema'
import { MAX_SECTION_BYTES, saveSectionContent } from './section-helpers'
import { getPortfolioSections } from './section-settings'

type Tx = Transaction<Database>

export const REVIEW_PERMISSION = 'context.suggestion.review' as const

export interface NewSuggestion {
  key: string
  baseContent: string
  proposedContent: string
}

export function assertSuggestionSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SECTION_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Section content exceeds 100KB limit.' })
  }
}

// Creates one set holding a suggestion per item. A pending suggestion from the
// same author for the same section is marked `superseded` first, so each
// author has at most one pending suggestion per section.
export async function createSuggestionSet(
  tx: Tx,
  input: { portfolioId: string, authorId: string, note: string | null, items: NewSuggestion[] }
): Promise<{ setId: string, suggestions: Array<{ id: string, key: string }> }> {
  for (const item of input.items) assertSuggestionSize(item.proposedContent)

  const set = await tx
    .insertInto('context_suggestion_sets')
    .values({ portfolio_id: input.portfolioId, author_id: input.authorId, note: input.note })
    .returning('id')
    .executeTakeFirstOrThrow()

  const suggestions: Array<{ id: string, key: string }> = []
  for (const item of input.items) {
    await supersedeOwnPending(tx, input.portfolioId, item.key, input.authorId)
    const id = await insertSuggestion(tx, set.id, input.portfolioId, item)
    suggestions.push({ id, key: item.key })
  }

  await notifyReviewers(tx, {
    setId: set.id,
    portfolioId: input.portfolioId,
    authorId: input.authorId,
    note: input.note,
    keys: input.items.map(i => i.key)
  })

  return { setId: set.id, suggestions }
}

async function supersedeOwnPending(tx: Tx, portfolioId: string, key: string, authorId: string): Promise<void> {
  const superseded = await tx
    .updateTable('context_suggestions')
    .set({ status: 'superseded', decided_at: sql<Date>`now()` })
    .where('portfolio_id', '=', portfolioId)
    .where('section_key', '=', key)
    .where('status', '=', 'pending')
    .where('set_id', 'in', tx
      .selectFrom('context_suggestion_sets')
      .select('id')
      .where('author_id', '=', authorId))
    .returning('set_id')
    .execute()
  for (const setId of new Set(superseded.map(r => r.set_id))) await resolveSetNotifications(tx, setId)
}

async function insertSuggestion(tx: Tx, setId: string, portfolioId: string, item: NewSuggestion): Promise<string> {
  const row = await tx
    .insertInto('context_suggestions')
    .values({
      set_id: setId,
      portfolio_id: portfolioId,
      section_key: item.key,
      base_content: item.baseContent,
      proposed_content: item.proposedContent,
      status: 'pending',
      // Wall-clock time, not the transaction's: suggestions in one set then
      // sort in the order they were submitted.
      created_at: sql<Date>`clock_timestamp()`
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export function suggestionSetLink(setId: string): string {
  return `/context/suggestions/${setId}`
}

// Once nothing in a set is pending there is nothing left to review, so every
// reviewer's notification about it is marked read, not just the decider's.
async function resolveSetNotifications(tx: Tx, setId: string): Promise<void> {
  const pending = await tx
    .selectFrom('context_suggestions')
    .select('id')
    .where('set_id', '=', setId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  if (pending) return
  await tx
    .updateTable('notifications')
    .set({ read_at: sql<Date>`now()` })
    .where('app_id', '=', 'context')
    .where('link', '=', suggestionSetLink(setId))
    .where('read_at', 'is', null)
    .execute()
}

// Users in the active org (every user in single mode) holding `perm` through
// their roles or a direct grant. Role sets are resolved once per distinct
// role list.
async function usersWithPermission(tx: Tx, perm: Permission): Promise<string[]> {
  const orgRow = await sql<{ org: string | null }>`
    select nullif(current_setting('app.current_org', true), '') as org
  `.execute(tx)
  const orgId = orgRow.rows[0]?.org ?? null

  const candidates: Array<{ id: string, roles: string[] }> = []
  if (orgId) {
    const rows = await tx
      .selectFrom('memberships')
      .select(['user_id', 'roles'])
      .where('org_id', '=', orgId)
      .execute()
    for (const r of rows) candidates.push({ id: r.user_id, roles: r.roles ?? [] })
  } else {
    const rows = await tx.selectFrom('users').select(['id', 'roles', 'is_admin']).execute()
    for (const r of rows) {
      candidates.push({ id: r.id, roles: r.is_admin ? [...(r.roles ?? []), 'admin'] : (r.roles ?? []) })
    }
  }

  const byRoles = new Map<string, boolean>()
  const out = new Set<string>()
  for (const c of candidates) {
    const key = [...c.roles].sort().join(',')
    let allowed = byRoles.get(key)
    if (allowed === undefined) {
      allowed = (await getRolePermissions(tx, c.roles, orgId)).has(perm)
      byRoles.set(key, allowed)
    }
    if (allowed) out.add(c.id)
  }

  const granted = await tx
    .selectFrom('user_permission_grants')
    .select('user_id')
    .where('permission', '=', perm)
    .execute()
  for (const g of granted) out.add(g.user_id)

  return [...out]
}

// One bell notification per reviewer, batched into their daily digest email.
async function notifyReviewers(
  tx: Tx,
  input: { setId: string, portfolioId: string, authorId: string, note: string | null, keys: string[] }
): Promise<void> {
  const reviewers = await usersWithPermission(tx, REVIEW_PERMISSION)
  if (reviewers.length === 0) return

  const author = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', input.authorId)
    .executeTakeFirst()
  const portfolio = await tx
    .selectFrom('context_portfolios')
    .select(['id', 'name', 'template'])
    .where('id', '=', input.portfolioId)
    .executeTakeFirstOrThrow()
  const titles = new Map((await getPortfolioSections(tx, portfolio)).map(s => [s.key, s.title]))
  const sections = input.keys.map(k => titles.get(k) ?? k).join(', ')

  await createNotification(tx, reviewers.map(userId => ({
    userId,
    appId: 'context',
    title: `${author?.display_name || 'Someone'} suggested changes to ${portfolio.name}`,
    body: input.note ? `${sections} — ${input.note}` : sections,
    icon: 'i-lucide-git-pull-request-arrow',
    link: suggestionSetLink(input.setId),
    actorId: input.authorId,
    email: 'digest' as const
  })))
}

export interface SuggestionViewer {
  userId: string
  isReviewer: boolean
}

export interface SuggestionSetSummary {
  id: string
  portfolio_id: string
  portfolio_slug: string
  portfolio_name: string
  author_id: string | null
  author_name: string | null
  note: string | null
  created_at: Date
  counts: Partial<Record<ContextSuggestionStatus, number>>
  stale_count: number
  sections: Array<{ key: string, title: string, status: ContextSuggestionStatus }>
}

// Review queue. `open` = sets with at least one pending suggestion; `closed`
// = everything decided. Non-reviewers only see their own sets.
export async function listSuggestionSets(
  tx: Tx,
  viewer: SuggestionViewer,
  opts: { state: 'open' | 'closed', limit?: number }
): Promise<SuggestionSetSummary[]> {
  const hasPending = sql<boolean>`exists (
    select 1 from context_suggestions p
    where p.set_id = ss.id and p.status = 'pending'
  )`
  let q = tx
    .selectFrom('context_suggestion_sets as ss')
    .innerJoin('context_portfolios as p', 'p.id', 'ss.portfolio_id')
    .leftJoin('users as u', 'u.id', 'ss.author_id')
    .select([
      'ss.id',
      'ss.portfolio_id',
      'p.slug as portfolio_slug',
      'p.name as portfolio_name',
      'ss.author_id',
      'u.display_name as author_name',
      'ss.note',
      'ss.created_at'
    ])
    .where(opts.state === 'open' ? hasPending : sql<boolean>`not ${hasPending}`)
    .orderBy('ss.created_at', opts.state === 'open' ? 'asc' : 'desc')
    .limit(opts.limit ?? 100)
  if (!viewer.isReviewer) q = q.where('ss.author_id', '=', viewer.userId)
  const sets = await q.execute()
  if (sets.length === 0) return []

  const items = await tx
    .selectFrom('context_suggestions as sg')
    .leftJoin('context_sections as s', join => join
      .onRef('s.portfolio_id', '=', 'sg.portfolio_id')
      .onRef('s.section_key', '=', 'sg.section_key'))
    .select([
      'sg.set_id',
      'sg.portfolio_id',
      'sg.section_key',
      'sg.status',
      sql<boolean>`coalesce(s.content, '') <> sg.base_content`.as('stale')
    ])
    .where('sg.set_id', 'in', sets.map(s => s.id))
    .orderBy('sg.created_at')
    .execute()

  const titles = await sectionTitles(tx, [...new Set(sets.map(s => s.portfolio_id))])

  return sets.map((set) => {
    const mine = items.filter(i => i.set_id === set.id)
    const counts: Partial<Record<ContextSuggestionStatus, number>> = {}
    for (const i of mine) counts[i.status] = (counts[i.status] ?? 0) + 1
    return {
      ...set,
      counts,
      stale_count: mine.filter(i => i.status === 'pending' && i.stale).length,
      sections: mine.map(i => ({
        key: i.section_key,
        title: titles.get(`${i.portfolio_id}:${i.section_key}`) ?? i.section_key,
        status: i.status
      }))
    }
  })
}

async function sectionTitles(tx: Tx, portfolioIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (portfolioIds.length === 0) return out
  const portfolios = await tx
    .selectFrom('context_portfolios')
    .select(['id', 'template'])
    .where('id', 'in', portfolioIds)
    .execute()
  for (const p of portfolios) {
    for (const s of await getPortfolioSections(tx, p)) out.set(`${p.id}:${s.key}`, s.title)
  }
  return out
}

export interface SuggestionDetail {
  id: string
  section_key: string
  section_title: string
  section_exists: boolean
  status: ContextSuggestionStatus
  base_content: string
  proposed_content: string
  current_content: string
  stale: boolean
  decided_by_name: string | null
  decided_at: Date | null
  review_note: string | null
}

export interface SuggestionSetDetail extends Omit<SuggestionSetSummary, 'counts' | 'stale_count' | 'sections'> {
  suggestions: SuggestionDetail[]
}

// One set with its suggestions, the current content of each section, and
// whether that content moved since the suggestion was made. 404 when the set
// doesn't exist or the viewer may not see it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Suggestion not found.' })
}

export async function getSuggestionSetOr404(
  tx: Tx,
  setId: string,
  viewer: SuggestionViewer
): Promise<SuggestionSetDetail> {
  if (!UUID_RE.test(setId)) notFound()
  const set = await tx
    .selectFrom('context_suggestion_sets as ss')
    .innerJoin('context_portfolios as p', 'p.id', 'ss.portfolio_id')
    .leftJoin('users as u', 'u.id', 'ss.author_id')
    .select([
      'ss.id',
      'ss.portfolio_id',
      'p.slug as portfolio_slug',
      'p.name as portfolio_name',
      'ss.author_id',
      'u.display_name as author_name',
      'ss.note',
      'ss.created_at'
    ])
    .where('ss.id', '=', setId)
    .executeTakeFirst()
  if (!set || (!viewer.isReviewer && set.author_id !== viewer.userId)) notFound()

  const rows = await tx
    .selectFrom('context_suggestions as sg')
    .leftJoin('context_sections as s', join => join
      .onRef('s.portfolio_id', '=', 'sg.portfolio_id')
      .onRef('s.section_key', '=', 'sg.section_key'))
    .leftJoin('users as d', 'd.id', 'sg.decided_by')
    .select([
      'sg.id',
      'sg.section_key',
      'sg.status',
      'sg.base_content',
      'sg.proposed_content',
      's.content as current_content',
      'd.display_name as decided_by_name',
      'sg.decided_at',
      'sg.review_note'
    ])
    .where('sg.set_id', '=', setId)
    .orderBy('sg.created_at')
    .execute()

  const defs = new Map((await getPortfolioSections(tx, set.portfolio_id)).map(s => [s.key, s.title]))

  return {
    ...set,
    suggestions: rows.map((r) => {
      const current = r.current_content ?? ''
      return {
        id: r.id,
        section_key: r.section_key,
        section_title: defs.get(r.section_key) ?? r.section_key,
        section_exists: defs.has(r.section_key),
        status: r.status,
        base_content: r.base_content,
        proposed_content: r.proposed_content,
        current_content: current,
        stale: current !== r.base_content,
        decided_by_name: r.decided_by_name,
        decided_at: r.decided_at,
        review_note: r.review_note
      }
    })
  }
}

// Pending suggestions in a set, narrowed to `ids` when given. Every id must
// name a pending suggestion in the set.
async function pendingInSet(tx: Tx, setId: string, ids?: string[]) {
  const rows = await tx
    .selectFrom('context_suggestions')
    .select(['id', 'portfolio_id', 'section_key', 'proposed_content'])
    .where('set_id', '=', setId)
    .where('status', '=', 'pending')
    .orderBy('created_at')
    .execute()
  if (!ids) {
    if (rows.length === 0) throw createError({ statusCode: 409, statusMessage: 'Nothing pending in this suggestion.' })
    return rows
  }
  const pending = new Set(rows.map(r => r.id))
  const notPending = ids.filter(id => !pending.has(id))
  if (notPending.length > 0) {
    throw createError({ statusCode: 409, statusMessage: 'Some suggestions are no longer pending. Reload and try again.' })
  }
  return rows.filter(r => ids.includes(r.id))
}

// Approve or reject pending suggestions in a set. An approval writes the
// section as the suggester (the reviewer when the suggester's account is
// gone) and links the version to the suggestion. `content` approves a single
// suggestion with the reviewer's edits; that version is written as the
// reviewer, and the suggestion keeps the content as proposed.
export async function decideSuggestions(
  tx: Tx,
  setId: string,
  input: { action: 'approve' | 'reject', ids?: string[], note?: string | null, content?: string },
  reviewerId: string
): Promise<Array<{ id: string, portfolio_id: string, section_key: string, section_id?: string, version_id?: string }>> {
  if (!UUID_RE.test(setId)) notFound()
  const set = await tx
    .selectFrom('context_suggestion_sets')
    .select(['id', 'author_id'])
    .where('id', '=', setId)
    .executeTakeFirst()
  if (!set) notFound()
  if (input.content !== undefined && (input.action !== 'approve' || input.ids?.length !== 1)) {
    throw createError({ statusCode: 400, statusMessage: 'Edited content approves exactly one suggestion.' })
  }

  const targets = await pendingInSet(tx, setId, input.ids)
  const decided: Array<{ id: string, portfolio_id: string, section_key: string, section_id?: string, version_id?: string }> = []
  for (const t of targets) {
    let written: { section_id: string, version_id: string } | undefined
    if (input.action === 'approve') {
      const edited = input.content !== undefined && input.content !== t.proposed_content
      const { section, versionId } = await saveSectionContent(
        tx, t.portfolio_id, t.section_key,
        edited ? input.content! : t.proposed_content,
        edited ? reviewerId : (set.author_id ?? reviewerId),
        { source: 'suggestion', suggestionId: t.id }
      )
      written = { section_id: section.id, version_id: versionId }
    }
    await tx
      .updateTable('context_suggestions')
      .set({
        status: input.action === 'approve' ? 'approved' : 'rejected',
        decided_by: reviewerId,
        decided_at: sql<Date>`now()`,
        review_note: input.note?.trim() || null
      })
      .where('id', '=', t.id)
      .execute()
    decided.push({ id: t.id, portfolio_id: t.portfolio_id, section_key: t.section_key, ...written })
  }
  await resolveSetNotifications(tx, setId)
  return decided
}

// The author takes back pending suggestions from their own set.
export async function withdrawSuggestions(
  tx: Tx,
  setId: string,
  ids: string[] | undefined,
  userId: string
): Promise<string[]> {
  if (!UUID_RE.test(setId)) notFound()
  const set = await tx
    .selectFrom('context_suggestion_sets')
    .select(['id', 'author_id'])
    .where('id', '=', setId)
    .executeTakeFirst()
  if (!set || set.author_id !== userId) notFound()
  const targets = await pendingInSet(tx, setId, ids)
  await tx
    .updateTable('context_suggestions')
    .set({ status: 'withdrawn', decided_by: userId, decided_at: sql<Date>`now()` })
    .where('id', 'in', targets.map(t => t.id))
    .execute()
  await resolveSetNotifications(tx, setId)
  return targets.map(t => t.id)
}

// The author revises their own open set in place. A key already pending in
// the set gets the new proposed content and keeps its base, so review still
// flags changes made to the section since it was first suggested. Any other
// key is added to the set, superseding the author's pending suggestion on it
// elsewhere. `note` replaces the set's note when given.
export async function reviseSuggestionSet(
  tx: Tx,
  setId: string,
  input: { note?: string | null, items: NewSuggestion[] },
  authorId: string
): Promise<Array<{ id: string, key: string, status: 'revised' | 'added' }>> {
  if (!UUID_RE.test(setId)) notFound()
  const set = await tx
    .selectFrom('context_suggestion_sets')
    .select(['id', 'portfolio_id', 'author_id'])
    .where('id', '=', setId)
    .executeTakeFirst()
  if (!set || set.author_id !== authorId) notFound()
  for (const item of input.items) assertSuggestionSize(item.proposedContent)

  const pending = await tx
    .selectFrom('context_suggestions')
    .select(['id', 'section_key'])
    .where('set_id', '=', setId)
    .where('status', '=', 'pending')
    .execute()
  if (pending.length === 0) {
    throw createError({ statusCode: 409, statusMessage: 'Nothing pending in this suggestion; make a new one instead.' })
  }

  const idByKey = new Map(pending.map(p => [p.section_key, p.id]))
  const out: Array<{ id: string, key: string, status: 'revised' | 'added' }> = []
  for (const item of input.items) {
    const existing = idByKey.get(item.key)
    if (existing) {
      await tx
        .updateTable('context_suggestions')
        .set({ proposed_content: item.proposedContent })
        .where('id', '=', existing)
        .execute()
      out.push({ id: existing, key: item.key, status: 'revised' })
      continue
    }
    await supersedeOwnPending(tx, set.portfolio_id, item.key, authorId)
    const id = await insertSuggestion(tx, setId, set.portfolio_id, item)
    idByKey.set(item.key, id)
    out.push({ id, key: item.key, status: 'added' })
  }

  if (input.note !== undefined) {
    await tx
      .updateTable('context_suggestion_sets')
      .set({ note: input.note?.trim() || null })
      .where('id', '=', setId)
      .execute()
  }
  return out
}

// Marks the viewer's unread notifications about a set read.
export async function markSuggestionSetNotificationsRead(tx: Tx, setId: string, userId: string): Promise<void> {
  if (!UUID_RE.test(setId)) notFound()
  await tx
    .updateTable('notifications')
    .set({ read_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('app_id', '=', 'context')
    .where('link', '=', suggestionSetLink(setId))
    .where('read_at', 'is', null)
    .execute()
}

// Pending suggestions on one section: the total, plus the ones the viewer may
// open (all for a reviewer, their own otherwise).
export async function pendingForSection(
  tx: Tx,
  portfolioId: string,
  key: string,
  viewer: SuggestionViewer
): Promise<{ total: number, visible: Array<{ id: string, set_id: string, author_id: string | null, author_name: string | null, created_at: Date }> }> {
  const rows = await tx
    .selectFrom('context_suggestions as sg')
    .innerJoin('context_suggestion_sets as ss', 'ss.id', 'sg.set_id')
    .leftJoin('users as u', 'u.id', 'ss.author_id')
    .select(['sg.id', 'sg.set_id', 'ss.author_id', 'u.display_name as author_name', 'sg.created_at'])
    .where('sg.portfolio_id', '=', portfolioId)
    .where('sg.section_key', '=', key)
    .where('sg.status', '=', 'pending')
    .orderBy('sg.created_at')
    .execute()
  return {
    total: rows.length,
    visible: rows.filter(r => viewer.isReviewer || r.author_id === viewer.userId)
  }
}

// Pending suggestion count per section key in a portfolio.
export async function pendingCountsByKey(tx: Tx, portfolioId: string): Promise<Map<string, number>> {
  const rows = await tx
    .selectFrom('context_suggestions')
    .select(['section_key', sql<string>`count(*)`.as('n')])
    .where('portfolio_id', '=', portfolioId)
    .where('status', '=', 'pending')
    .groupBy('section_key')
    .execute()
  return new Map(rows.map(r => [r.section_key, Number(r.n)]))
}

// Number of open sets the viewer can see in the queue.
export async function countOpenSets(tx: Tx, viewer: SuggestionViewer): Promise<number> {
  let q = tx
    .selectFrom('context_suggestion_sets as ss')
    .select(sql<string>`count(*)`.as('n'))
    .where(sql<boolean>`exists (
      select 1 from context_suggestions p
      where p.set_id = ss.id and p.status = 'pending'
    )`)
  if (!viewer.isReviewer) q = q.where('ss.author_id', '=', viewer.userId)
  const row = await q.executeTakeFirstOrThrow()
  return Number(row.n)
}

// The caller's own suggestions, newest first, for the MCP `list_suggestions`
// tool.
export async function listOwnSuggestions(
  tx: Tx,
  authorId: string,
  opts: { portfolioId?: string, status?: ContextSuggestionStatus, limit: number }
) {
  let q = tx
    .selectFrom('context_suggestions as sg')
    .innerJoin('context_suggestion_sets as ss', 'ss.id', 'sg.set_id')
    .select([
      'sg.id',
      'sg.set_id',
      'sg.portfolio_id',
      'sg.section_key',
      'sg.status',
      'sg.created_at',
      'sg.decided_at',
      'sg.review_note',
      sql<number>`length(sg.proposed_content)`.as('proposed_content_length')
    ])
    .where('ss.author_id', '=', authorId)
    .orderBy('sg.created_at', 'desc')
    .limit(opts.limit)
  if (opts.portfolioId) q = q.where('sg.portfolio_id', '=', opts.portfolioId)
  if (opts.status) q = q.where('sg.status', '=', opts.status)
  return await q.execute()
}

// The caller's pending suggestion on a section, if any.
export async function ownPendingSuggestion(
  tx: Tx,
  portfolioId: string,
  key: string,
  authorId: string
): Promise<{ id: string, set_id: string } | null> {
  const row = await tx
    .selectFrom('context_suggestions as sg')
    .innerJoin('context_suggestion_sets as ss', 'ss.id', 'sg.set_id')
    .select(['sg.id', 'sg.set_id'])
    .where('sg.portfolio_id', '=', portfolioId)
    .where('sg.section_key', '=', key)
    .where('sg.status', '=', 'pending')
    .where('ss.author_id', '=', authorId)
    .executeTakeFirst()
  return row ?? null
}
