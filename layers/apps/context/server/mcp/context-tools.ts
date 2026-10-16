// MCP tool definitions for the context layer.
//
// Scopes track the equivalent HTTP routes' permissions: reads use
// `context.read`; section-content writes use `context.write`; creating a
// portfolio requires the portfolio-create permission; adding or removing a
// section definition requires the section permission.
// All tools except `list_orgs` take an optional `org` slug and run inside
// `runInOrgTransaction(event, { org, userId }, ...)` from `#tenant/server`,
// which in multi mode resolves the org (the `org` input, else the
// `X-Active-Org` header on the MCP HTTP request), enforces the bearer's
// membership, and sets the active-org GUC; in single mode it is a plain
// transaction. The transaction spans the whole handler, so a tool that
// returns an error has written nothing.
//
// `read_organization` is the source-API name — it returns the whole portfolio
// (sections + content) for a given portfolio_id. The name is preserved for
// backward compat with users' MCP clients even though the scope is now per
// portfolio rather than per organization.
//
// `update_section` and `bulk_update_sections` support optimistic locking via
// an optional `last_edited_at` ISO timestamp. If the section has been edited
// since the caller's read, the update is rejected with `status: 'conflict'`.
//
// Both update tools suggest by default: a change to a section with content
// becomes a pending suggestion (one set per call) that a reviewer approves in
// the web app. Writing into an empty section applies immediately, since
// there is nothing to overwrite. `mode: 'direct'` writes straight through.

import { z } from 'zod'
import { sql, type Kysely } from 'kysely'
import { defineMcpTool, mcpError, mcpLog, type McpToolContext } from '#mcp-layer'
import type { Database as CoreDatabase } from '#core/server/database/schema'
import { runInOrgTransaction } from '#tenant/server'
import { getPortfolioSections } from '../utils/section-settings'
import { loadSection, saveSectionContent, isKnownSectionKey, addSection, deleteSection } from '../utils/section-helpers'
import { createPortfolio, getPortfolioById, listPortfolios } from '../utils/portfolio-helpers'
import {
  createSuggestionSet,
  getSuggestionSetOr404,
  listOwnSuggestions,
  ownPendingSuggestion,
  reviseSuggestionSet,
  withdrawSuggestions,
  type NewSuggestion
} from '../utils/suggestions'
import { CONTEXT_SECTIONS } from '../utils/section-catalog'

// Keys of the default template. A portfolio built from another template has
// that template's keys; an unknown key's error lists the valid ones.
const BUILTIN_KEY_LIST = CONTEXT_SECTIONS.map(s => s.key).join(', ')

function asAuditExecutor(tx: unknown): Kysely<CoreDatabase> {
  return tx as Kysely<CoreDatabase>
}

// Org slug selecting which org the tool runs in. Optional so clients pinned
// to one org via a fixed `X-Active-Org` header keep working unchanged.
const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

const modeInput = z.enum(['suggest', 'direct']).optional()
  .describe('suggest (default): the change waits for an admin to approve it. direct: write immediately — only when the user explicitly asks to bypass review.')
const noteInput = z.string().trim().max(1000).optional()
  .describe('Short summary of the change and why, shown to the reviewer.')

// Appended to the update tools' descriptions so the writing AI keeps personal
// information about private individuals out of context.
const PRIVACY_INSTRUCTION = 'Privacy: do not include personal information about private individuals. Refer to people by role or initials (e.g. "J.S., field coordinator"). Organization and project names (e.g. Joshua Project) and publicly known figures may be written in full. Do not include personal email addresses, phone numbers, or home addresses.'

const SUGGESTED_NOTE = 'Pending review by an admin; the section keeps its current content until the suggestion is approved.'

const REVISE_INSTRUCTION = 'To change a suggestion you already made, or to add another section to it, call update_suggestion with its suggestion_set_id instead of suggesting again.'

function hasContent(content: string | undefined | null): boolean {
  return (content ?? '').trim().length > 0
}

function textResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {})
  }
}

export const listOrgsTool = defineMcpTool({
  name: 'list_orgs',
  title: 'List Organizations',
  description: 'List organizations the bearer is a member of. Returns org id, slug, and name. Pass a slug as `org` to any other tool to operate in that org.',
  scope: 'context.read',
  input: z.object({}).strict(),
  handler: async (_input, ctx) => {
    try {
      // The MCP server's tenancy middleware resolves the active org from the
      // X-Active-Org header. We use the user's membership table directly so
      // the response lists ALL orgs the bearer can switch to, not just the
      // currently active one.
      return await runInOrgTransaction(ctx.event, async (tx) => {
        const rows = await tx
          .selectFrom('memberships as m')
          .innerJoin('orgs as o', 'o.id', 'm.org_id')
          .select(['o.id', 'o.slug', 'o.name'])
          .where('m.user_id', '=', ctx.auth.userId)
          .orderBy('o.name', 'asc')
          .distinct()
          .execute()
        return textResult(`${rows.length} org(s).`, { orgs: rows })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const listPortfoliosTool = defineMcpTool({
  name: 'list_portfolios',
  title: 'List Portfolios',
  description: 'List portfolios in the active organization. Returns portfolio id, slug, name, color, icon_url, template (null = the default template), created_at, updated_at.',
  scope: 'context.read',
  input: z.object({ org: orgInput }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const rows = await listPortfolios(tx)
        return textResult(`${rows.length} portfolio(s).`, { portfolios: rows })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const listSectionsTool = defineMcpTool({
  name: 'list_sections',
  title: 'List Sections',
  description: 'List all sections in a portfolio with titles, descriptions, content_length, and last_edited_at. Survey step: use content_length to decide which sections to load.',
  scope: 'context.read',
  input: z.object({ org: orgInput, portfolio_id: z.string().uuid() }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const exists = await tx
          .selectFrom('context_portfolios')
          .select(['id', 'template'])
          .where('id', '=', input.portfolio_id)
          .executeTakeFirst()
        if (!exists) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const defs = await getPortfolioSections(tx, exists)
        const rows = await tx
          .selectFrom('context_sections')
          .select(['section_key', 'content', 'last_edited_at'])
          .where('portfolio_id', '=', input.portfolio_id)
          .execute()
        const byKey = new Map(rows.map(r => [r.section_key as string, r]))
        const result = defs.map((d) => {
          const r = byKey.get(d.key)
          const content = (r?.content ?? '') as string
          return {
            key: d.key,
            title: d.title,
            description: d.description,
            is_custom: d.is_custom,
            has_content: content.trim().length > 0,
            content_length: content.length,
            last_edited_at: r?.last_edited_at ? new Date(r.last_edited_at as Date).toISOString() : null
          }
        })
        return textResult(`${result.length} section(s).`, { sections: result })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const readSectionTool = defineMcpTool({
  name: 'read_section',
  title: 'Read Section',
  description: 'Read the markdown content of a single portfolio section. Returns content and last_edited_at (pass last_edited_at to update_section for optimistic-lock conflict detection), plus pending_suggestion_id and pending_suggestion_set_id when you have a suggestion awaiting review on it.',
  scope: 'context.read',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    section_key: z.string().min(1).max(64)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const exists = await tx
          .selectFrom('context_portfolios')
          .select(['id', 'template'])
          .where('id', '=', input.portfolio_id)
          .executeTakeFirst()
        if (!exists) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const known = await isKnownSectionKey(tx, input.portfolio_id, input.section_key)
        if (!known) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${input.section_key}` })

        const section = await loadSection(tx, input.portfolio_id, input.section_key)
        const defs = await getPortfolioSections(tx, exists)
        const def = defs.find(d => d.key === input.section_key)
        const pending = await ownPendingSuggestion(tx, input.portfolio_id, input.section_key, ctx.auth.userId)
        const result = {
          key: input.section_key,
          title: def?.title ?? input.section_key,
          content: section?.content ?? '',
          last_edited_at: section?.last_edited_at ? new Date(section.last_edited_at).toISOString() : null,
          pending_suggestion_id: pending?.id ?? null,
          pending_suggestion_set_id: pending?.set_id ?? null
        }
        return textResult(`Section "${result.title}" (${result.content.length} chars).`, result)
      })
    } catch (err) { return mcpError(err) }
  }
})

export const bulkReadSectionsTool = defineMcpTool({
  name: 'bulk_read_sections',
  title: 'Read Several Sections',
  description: 'Read multiple portfolio sections in a single call. Validates all keys up front; rejects unknown keys.',
  scope: 'context.read',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    section_keys: z.array(z.string().min(1).max(64)).min(1).max(50)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const defs = await getPortfolioSections(tx, input.portfolio_id)
        const knownKeys = new Set(defs.map(d => d.key))
        const unknown = input.section_keys.filter(k => !knownKeys.has(k))
        if (unknown.length > 0) {
          throw createError({ statusCode: 404, statusMessage: `Unknown section keys: ${unknown.join(', ')}` })
        }

        const rows = await tx
          .selectFrom('context_sections')
          .select(['section_key', 'content', 'last_edited_at'])
          .where('portfolio_id', '=', input.portfolio_id)
          .where('section_key', 'in', input.section_keys)
          .execute()
        const byKey = new Map(rows.map(r => [r.section_key as string, r]))

        const sections = input.section_keys.map((key) => {
          const r = byKey.get(key)
          const def = defs.find(d => d.key === key)
          return {
            key,
            title: def?.title ?? key,
            content: (r?.content as string) ?? '',
            last_edited_at: r?.last_edited_at ? new Date(r.last_edited_at as Date).toISOString() : null
          }
        })
        return textResult(`Read ${sections.length} section(s).`, { sections })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const readOrganizationTool = defineMcpTool({
  name: 'read_organization',
  title: 'Read Whole Portfolio',
  description: 'Read all sections of a portfolio in one call (sections + content). Use when you need broad context across the whole portfolio.',
  scope: 'context.read',
  input: z.object({ org: orgInput, portfolio_id: z.string().uuid() }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const p = await tx
          .selectFrom('context_portfolios')
          .select(['id', 'slug', 'name', 'template'])
          .where('id', '=', input.portfolio_id)
          .executeTakeFirst()
        if (!p) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const defs = await getPortfolioSections(tx, p)
        const rows = await tx
          .selectFrom('context_sections')
          .select(['section_key', 'content', 'last_edited_at'])
          .where('portfolio_id', '=', input.portfolio_id)
          .execute()
        const byKey = new Map(rows.map(r => [r.section_key as string, r]))

        const sections = defs.map((d) => {
          const r = byKey.get(d.key)
          return {
            key: d.key,
            title: d.title,
            description: d.description,
            is_custom: d.is_custom,
            content: (r?.content as string) ?? '',
            last_edited_at: r?.last_edited_at ? new Date(r.last_edited_at as Date).toISOString() : null
          }
        })

        return textResult(`Portfolio "${p.name}" (${sections.length} sections).`, {
          portfolio: { id: p.id, slug: p.slug, name: p.name },
          sections
        })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const updateSectionTool = defineMcpTool({
  name: 'update_section',
  title: 'Update Section',
  description: `Update the markdown content of a portfolio section. By default this suggests the change: it returns status "suggested" and the section is unchanged until an admin approves it. Writing into an empty section applies immediately (status "updated"). Pass mode "direct" only when the user explicitly asks to skip review. Pass last_edited_at (ISO timestamp from a prior read) to enable optimistic-lock conflict detection. Atomic: if the call returns an error, nothing was written. ${REVISE_INSTRUCTION} ${PRIVACY_INSTRUCTION}`,
  scope: 'context.write',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    section_key: z.string().min(1).max(64),
    content: z.string(),
    last_edited_at: z.string().datetime().optional(),
    mode: modeInput,
    note: noteInput
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const exists = await tx
          .selectFrom('context_portfolios')
          .select('id')
          .where('id', '=', input.portfolio_id)
          .executeTakeFirst()
        if (!exists) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const known = await isKnownSectionKey(tx, input.portfolio_id, input.section_key)
        if (!known) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${input.section_key}` })

        const cur = await loadSection(tx, input.portfolio_id, input.section_key)
        if (input.last_edited_at) {
          if (cur && cur.last_edited_at) {
            const currentIso = new Date(cur.last_edited_at).toISOString()
            if (currentIso !== new Date(input.last_edited_at).toISOString()) {
              return textResult('Conflict — section was modified since your read.', {
                key: input.section_key,
                status: 'conflict',
                reason: 'Section was modified after your last read. Re-read before updating.',
                current_last_edited_at: currentIso,
                your_last_edited_at: input.last_edited_at
              })
            }
          }
        }

        if (input.mode !== 'direct' && hasContent(cur?.content)) {
          if (input.content === cur!.content) {
            return textResult(`No change — section "${input.section_key}" already has this content.`, {
              key: input.section_key,
              status: 'unchanged' as const
            })
          }
          const { setId, suggestions } = await createSuggestionSet(tx, {
            portfolioId: input.portfolio_id,
            authorId: ctx.auth.userId,
            note: input.note || null,
            items: [{ key: input.section_key, baseContent: cur!.content, proposedContent: input.content }]
          })
          await mcpLog('CREATE', 'context_suggestion_sets', setId, ctx, {
            portfolio_id: input.portfolio_id,
            keys: [input.section_key]
          }, asAuditExecutor(tx))
          return textResult(`Suggested an update to section "${input.section_key}". ${SUGGESTED_NOTE}`, {
            key: input.section_key,
            status: 'suggested' as const,
            suggestion_id: suggestions[0]!.id,
            suggestion_set_id: setId
          })
        }

        const { section, versionId } = await saveSectionContent(
          tx, input.portfolio_id, input.section_key, input.content, ctx.auth.userId, { source: 'mcp' }
        )

        await mcpLog('UPDATE', 'context_sections', section.id, ctx, {
          portfolio_id: input.portfolio_id,
          key: input.section_key,
          version_id: versionId
        }, asAuditExecutor(tx))

        return textResult(`Updated section "${input.section_key}".`, {
          key: input.section_key,
          status: 'updated' as const,
          last_edited_at: new Date(section.last_edited_at).toISOString(),
          version_id: versionId
        })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const bulkUpdateSectionsTool = defineMcpTool({
  name: 'bulk_update_sections',
  title: 'Update Several Sections',
  description: `Update multiple portfolio sections in a single call. By default the changes are suggested: sections with content come back with status "suggested" and are grouped into one suggestion an admin reviews; empty sections are written immediately (status "updated"). Pass mode "direct" only when the user explicitly asks to skip review. Each update may include last_edited_at for optimistic-lock conflict detection. Conflicted sections are skipped; sections that pass are still processed. Runs as one transaction: if the call returns an error, nothing in it was written or suggested. ${REVISE_INSTRUCTION} ${PRIVACY_INSTRUCTION}`,
  scope: 'context.write',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    updates: z.array(z.object({
      section_key: z.string().min(1).max(64),
      content: z.string(),
      last_edited_at: z.string().datetime().optional()
    })).min(1).max(20),
    mode: modeInput,
    note: noteInput
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const exists = await tx
          .selectFrom('context_portfolios')
          .select('id')
          .where('id', '=', input.portfolio_id)
          .executeTakeFirst()
        if (!exists) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const results: Array<Record<string, unknown>> = []
        const toSuggest: Array<NewSuggestion & { result: Record<string, unknown> }> = []
        for (const u of input.updates) {
          const known = await isKnownSectionKey(tx, input.portfolio_id, u.section_key)
          if (!known) {
            results.push({ key: u.section_key, status: 'error', reason: `Unknown section key: ${u.section_key}` })
            continue
          }
          const cur = await loadSection(tx, input.portfolio_id, u.section_key)
          if (u.last_edited_at) {
            if (cur?.last_edited_at) {
              const currentIso = new Date(cur.last_edited_at).toISOString()
              if (currentIso !== new Date(u.last_edited_at).toISOString()) {
                results.push({
                  key: u.section_key,
                  status: 'conflict',
                  reason: 'Section was modified after your last read.',
                  current_last_edited_at: currentIso,
                  your_last_edited_at: u.last_edited_at
                })
                continue
              }
            }
          }
          if (input.mode !== 'direct' && hasContent(cur?.content)) {
            if (u.content === cur!.content) {
              results.push({ key: u.section_key, status: 'unchanged' })
              continue
            }
            const result: Record<string, unknown> = { key: u.section_key, status: 'suggested' }
            results.push(result)
            toSuggest.push({ key: u.section_key, baseContent: cur!.content, proposedContent: u.content, result })
            continue
          }
          const { section, versionId } = await saveSectionContent(
            tx, input.portfolio_id, u.section_key, u.content, ctx.auth.userId, { source: 'mcp' }
          )
          await mcpLog('UPDATE', 'context_sections', section.id, ctx, {
            portfolio_id: input.portfolio_id, key: u.section_key, version_id: versionId
          }, asAuditExecutor(tx))
          results.push({
            key: u.section_key,
            status: 'updated',
            last_edited_at: new Date(section.last_edited_at).toISOString(),
            version_id: versionId
          })
        }

        let setId: string | null = null
        if (toSuggest.length > 0) {
          const created = await createSuggestionSet(tx, {
            portfolioId: input.portfolio_id,
            authorId: ctx.auth.userId,
            note: input.note || null,
            items: toSuggest
          })
          setId = created.setId
          // A key repeated in one call supersedes its earlier entry.
          const idByKey = new Map(created.suggestions.map(s => [s.key, s.id]))
          for (const t of toSuggest) {
            t.result.suggestion_id = idByKey.get(t.key)
            t.result.suggestion_set_id = setId
          }
          await mcpLog('CREATE', 'context_suggestion_sets', setId, ctx, {
            portfolio_id: input.portfolio_id,
            keys: toSuggest.map(t => t.key)
          }, asAuditExecutor(tx))
        }

        return textResult(
          `Processed ${results.length} update(s).`
          + (toSuggest.length > 0 ? ` ${toSuggest.length} suggested — ${SUGGESTED_NOTE}` : ''),
          { results, ...(setId ? { suggestion_set_id: setId } : {}) }
        )
      })
    } catch (err) { return mcpError(err) }
  }
})

export const createPortfolioTool = defineMcpTool({
  name: 'create_portfolio',
  title: 'Create Portfolio',
  description: `Create a portfolio in the active organization. The slug is derived from the name unless one is given, and a colliding slug is auto-suffixed (-2, -3) — read the returned slug and id rather than assuming them. \`template\` picks a registered portfolio template (omit for the default template; an unknown id is rejected with the registered ids). \`builtin_sections\` picks which of the template's sections the portfolio starts with (omit for all, [] for none; default template keys: ${BUILTIN_KEY_LIST}). Sections start with no content; write content with update_section.`,
  scope: 'context.portfolio.create',
  input: z.object({
    org: orgInput,
    name: z.string().trim().min(1).max(120),
    color: z.string().trim().max(20).nullable().optional(),
    slug: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
    template: z.string().min(1).max(64).optional(),
    builtin_sections: z.array(z.string().min(1).max(64)).max(50).optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const portfolio = await createPortfolio(tx, input, ctx.auth.userId)

        await mcpLog('CREATE', 'context_portfolios', portfolio.id, ctx, {
          slug: portfolio.slug,
          name: portfolio.name
        }, asAuditExecutor(tx))

        return textResult(`Created portfolio "${portfolio.name}" (${portfolio.slug}).`, { portfolio })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const createSectionTool = defineMcpTool({
  name: 'create_section',
  title: 'Add Section',
  description: `Add a section to a portfolio. Pass \`key\` to add a built-in section from the portfolio's template (default template keys: ${BUILTIN_KEY_LIST}) — this is also how a deleted built-in is brought back, with its earlier content. Or pass \`title\` (plus optional description/order) to create a custom section; its key is slugified from the title and may not collide with a built-in key. Creates the definition only — write content afterwards with update_section.`,
  scope: 'context.section.custom',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    key: z.string().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    order: z.number().int().min(0).optional()
  }).strict().refine(d => (d.key !== undefined) !== (d.title !== undefined), {
    message: 'Pass exactly one of key (built-in) or title (custom).'
  }),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const portfolio = await getPortfolioById(tx, input.portfolio_id)
        if (!portfolio) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const section = await addSection(
          tx,
          portfolio,
          input.key !== undefined
            ? { key: input.key }
            : { title: input.title!, description: input.description, order: input.order },
          ctx.auth.userId
        )

        await mcpLog('CREATE', 'context_section_definitions', section.id, ctx, {
          portfolio_id: input.portfolio_id,
          key: section.key,
          title: section.title
        }, asAuditExecutor(tx))

        return textResult(
          `Added section "${section.title}" (key: ${section.key}). Write its content with update_section.`,
          { portfolio_id: input.portfolio_id, section }
        )
      })
    } catch (err) { return mcpError(err) }
  }
})

// addSection rejects a bad entry (not a built-in key, unusable title, key
// already in the portfolio) before it writes anything, so a batch can report
// that entry and carry on. Any other failure leaves the transaction unusable
// and aborts the whole call.
function rejectedEntryReason(err: unknown): string | null {
  const e = err as { statusCode?: number, statusMessage?: string, message?: string } | null
  if (e?.statusCode !== 400 && e?.statusCode !== 409) return null
  return e.statusMessage || e.message || 'Invalid section.'
}

export const bulkCreateSectionsTool = defineMcpTool({
  name: 'bulk_create_sections',
  title: 'Add Several Sections',
  description: `Add several sections to a portfolio in one call. Each entry takes what create_section takes: \`key\` for a built-in from the portfolio's template (default template keys: ${BUILTIN_KEY_LIST}), or \`title\` (plus optional description/order) for a custom section. Entries are applied in the order given and reported one by one — an entry that fails (not a built-in key, key already in the portfolio, title colliding with a built-in) comes back with status "error" and the rest still apply. Creates definitions only — write content afterwards with bulk_update_sections.`,
  scope: 'context.section.custom',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    sections: z.array(
      z.object({
        key: z.string().min(1).max(64).optional(),
        title: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).optional(),
        order: z.number().int().min(0).optional()
      }).strict().refine(d => (d.key !== undefined) !== (d.title !== undefined), {
        message: 'Each entry takes exactly one of key (built-in) or title (custom).'
      })
    ).min(1).max(20)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const portfolio = await getPortfolioById(tx, input.portfolio_id)
        if (!portfolio) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const results: Array<Record<string, unknown>> = []
        let created = 0
        for (const [index, entry] of input.sections.entries()) {
          try {
            const section = await addSection(
              tx,
              portfolio,
              entry.key !== undefined
                ? { key: entry.key }
                : { title: entry.title!, description: entry.description, order: entry.order },
              ctx.auth.userId
            )

            await mcpLog('CREATE', 'context_section_definitions', section.id, ctx, {
              portfolio_id: input.portfolio_id,
              key: section.key,
              title: section.title
            }, asAuditExecutor(tx))

            created++
            results.push({ index, key: section.key, status: 'created', section })
          } catch (err) {
            const reason = rejectedEntryReason(err)
            if (reason === null) throw err
            results.push({
              index,
              key: entry.key ?? null,
              title: entry.title ?? null,
              status: 'error',
              reason
            })
          }
        }

        return textResult(
          `Created ${created} of ${input.sections.length} section(s).`
          + (created > 0 ? ' Write their content with bulk_update_sections.' : ''),
          { portfolio_id: input.portfolio_id, results }
        )
      })
    } catch (err) { return mcpError(err) }
  }
})

export const deleteSectionTool = defineMcpTool({
  name: 'delete_section',
  title: 'Remove Section',
  description: 'Remove a section from a portfolio, built-in or custom. Any content saved under the key stays in the database but is no longer listed or readable; adding the section again (create_section with the same key or title) restores it.',
  scope: 'context.section.custom',
  destructive: true,
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid(),
    section_key: z.string().min(1).max(64)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const portfolio = await getPortfolioById(tx, input.portfolio_id)
        if (!portfolio) throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })

        const deleted = await deleteSection(tx, input.portfolio_id, input.section_key)

        await mcpLog('DELETE', 'context_section_definitions', deleted.id, ctx, {
          portfolio_id: input.portfolio_id,
          key: input.section_key
        }, asAuditExecutor(tx))

        return textResult(
          deleted.content_retained
            ? `Deleted section "${input.section_key}". Its content is retained but hidden until the section is added again.`
            : `Deleted section "${input.section_key}".`,
          {
            key: input.section_key,
            status: 'deleted' as const,
            ...deleted
          }
        )
      })
    } catch (err) { return mcpError(err) }
  }
})

export const listSuggestionsTool = defineMcpTool({
  name: 'list_suggestions',
  title: 'List My Suggestions',
  description: 'List your own suggested section updates, newest first, with status (pending, approved, rejected, withdrawn, superseded) and the reviewer\'s note when one was left. Use to check whether earlier suggestions were approved.',
  scope: 'context.read',
  input: z.object({
    org: orgInput,
    portfolio_id: z.string().uuid().optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const rows = await listOwnSuggestions(tx, ctx.auth.userId, {
          portfolioId: input.portfolio_id,
          status: input.status,
          limit: input.limit ?? 50
        })
        const suggestions = rows.map(r => ({
          ...r,
          created_at: new Date(r.created_at).toISOString(),
          decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null
        }))
        return textResult(`${suggestions.length} suggestion(s).`, { suggestions })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const withdrawSuggestionTool = defineMcpTool({
  name: 'withdraw_suggestion',
  title: 'Withdraw Suggestion',
  description: 'Withdraw one of your own pending suggestions so it leaves the review queue.',
  scope: 'context.write',
  input: z.object({
    org: orgInput,
    suggestion_id: z.string().uuid()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const row = await tx
          .selectFrom('context_suggestions')
          .select('set_id')
          .where('id', '=', input.suggestion_id)
          .executeTakeFirst()
        if (!row) throw createError({ statusCode: 404, statusMessage: 'Suggestion not found.' })

        await withdrawSuggestions(tx, row.set_id, [input.suggestion_id], ctx.auth.userId)

        await mcpLog('UPDATE', 'context_suggestions', input.suggestion_id, ctx, {
          status: 'withdrawn'
        }, asAuditExecutor(tx))

        return textResult('Suggestion withdrawn.', { suggestion_id: input.suggestion_id, status: 'withdrawn' as const })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const readSuggestionTool = defineMcpTool({
  name: 'read_suggestion',
  title: 'Read Suggestion',
  description: 'Read one of your own suggestions: each section it touches with its status, the proposed content, and whether the section changed since it was suggested (stale). Use before update_suggestion to see what the suggestion currently proposes.',
  scope: 'context.read',
  input: z.object({
    org: orgInput,
    suggestion_set_id: z.string().uuid()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const set = await getSuggestionSetOr404(tx, input.suggestion_set_id, { userId: ctx.auth.userId, isReviewer: false })
        return textResult(`Suggestion on ${set.portfolio_name} with ${set.suggestions.length} section(s).`, {
          suggestion_set_id: set.id,
          portfolio_id: set.portfolio_id,
          note: set.note,
          created_at: new Date(set.created_at).toISOString(),
          suggestions: set.suggestions.map(s => ({
            id: s.id,
            section_key: s.section_key,
            section_title: s.section_title,
            status: s.status,
            proposed_content: s.proposed_content,
            stale: s.stale,
            review_note: s.review_note,
            decided_at: s.decided_at ? new Date(s.decided_at).toISOString() : null
          }))
        })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const updateSuggestionTool = defineMcpTool({
  name: 'update_suggestion',
  title: 'Update Suggestion',
  description: `Change one of your own pending suggestions in place instead of making a new one. Each update replaces the proposed content of a section already in the suggestion, or adds another section to it. Pass note to replace the note shown to the reviewer. Content is the full new section content, not a diff. Atomic: if the call returns an error, nothing was changed. ${PRIVACY_INSTRUCTION}`,
  scope: 'context.write',
  input: z.object({
    org: orgInput,
    suggestion_set_id: z.string().uuid(),
    updates: z.array(z.object({
      section_key: z.string().min(1).max(64),
      content: z.string()
    })).min(1).max(20).optional(),
    note: noteInput
  }).strict(),
  handler: async (input, ctx) => {
    try {
      return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        if (!input.updates && input.note === undefined) {
          throw createError({ statusCode: 400, statusMessage: 'Provide updates, note, or both.' })
        }
        const set = await tx
          .selectFrom('context_suggestion_sets')
          .select('portfolio_id')
          .where('id', '=', input.suggestion_set_id)
          .where('author_id', '=', ctx.auth.userId)
          .executeTakeFirst()
        if (!set) throw createError({ statusCode: 404, statusMessage: 'Suggestion not found.' })

        const items: NewSuggestion[] = []
        for (const u of input.updates ?? []) {
          const known = await isKnownSectionKey(tx, set.portfolio_id, u.section_key)
          if (!known) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${u.section_key}` })
          const cur = await loadSection(tx, set.portfolio_id, u.section_key)
          items.push({ key: u.section_key, baseContent: cur?.content ?? '', proposedContent: u.content })
        }

        const results = await reviseSuggestionSet(tx, input.suggestion_set_id, { note: input.note, items }, ctx.auth.userId)

        await mcpLog('UPDATE', 'context_suggestion_sets', input.suggestion_set_id, ctx, {
          portfolio_id: set.portfolio_id,
          keys: items.map(i => i.key),
          ...(input.note !== undefined ? { note: true } : {})
        }, asAuditExecutor(tx))

        return textResult(`Updated the suggestion. ${SUGGESTED_NOTE}`, {
          suggestion_set_id: input.suggestion_set_id,
          results
        })
      })
    } catch (err) { return mcpError(err) }
  }
})

export const contextMcpTools = [
  listOrgsTool,
  listPortfoliosTool,
  listSectionsTool,
  readSectionTool,
  bulkReadSectionsTool,
  readOrganizationTool,
  updateSectionTool,
  bulkUpdateSectionsTool,
  createPortfolioTool,
  createSectionTool,
  bulkCreateSectionsTool,
  deleteSectionTool,
  listSuggestionsTool,
  withdrawSuggestionTool,
  readSuggestionTool,
  updateSuggestionTool
]

// Suppress unused-imports warning when sql isn't directly referenced — the
// import is kept for symmetry with other layers' MCP files.
export const _sql = sql
