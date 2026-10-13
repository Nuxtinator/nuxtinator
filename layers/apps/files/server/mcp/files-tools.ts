// MCP tool definitions for the files layer.
//
// Read tools use scope `files.read`; write tools use `files.write`. Every
// tool takes an optional `org` slug and runs inside
// `runInOrgTransaction(event, { org, userId }, ...)` from `#tenant/server`,
// which in multi mode resolves the org (the `org` input, else the
// `X-Active-Org` header on the MCP HTTP request), enforces the bearer's
// membership, and sets the `app.current_org` GUC; in single mode it is a
// plain transaction.
//
// Documents and sites are exposed for create/update. Binary files upload in
// two steps: `files_begin_upload` hands out a presigned PUT URL the client
// sends the bytes to directly, then `files_complete_upload` records the item.
// Objects PUT but never completed stay in the bucket; nothing sweeps them.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sql, type Kysely, type Transaction } from 'kysely'
import { defineMcpTool, mcpError, mcpLog, type McpToolContext } from '#mcp-layer'
import type { Database, Database as CoreDatabase } from '#core/server/database/schema'
import { runInOrgTransaction } from '#tenant/server'
import { deleteFromS3, presignedPutUrl, statS3Object } from '#core/server/utils/storage'
import {
  loadItem, saveDocContent, MAX_DOC_BYTES, MAX_SITE_BYTES, MAX_FILE_MB, RAW_LINK_TTL_SECONDS
} from '../utils/file-helpers'

// The mcp-audit layer types its executor as `Kysely<CoreDatabase>` (core-only
// schema), while files-layer transactions carry the augmented Database type.
// Structurally identical at runtime; the cast is a TS-side bridge.
function asAuditExecutor(tx: unknown): Kysely<CoreDatabase> {
  return tx as Kysely<CoreDatabase>
}

// Org slug selecting which org the tool runs in. Optional so clients pinned
// to one org via a fixed `X-Active-Org` header keep working unchanged.
const orgInput = z.string().min(1).max(64).optional()
  .describe('Org slug to operate in. Defaults to the X-Active-Org header sent by the client.')

// Public share URLs. Absolute when NUXT_PUBLIC_SITE_URL is configured,
// otherwise root-relative paths.
function siteBase(): string {
  const siteUrl = (useRuntimeConfig().public as { siteUrl?: string }).siteUrl ?? ''
  return siteUrl.replace(/\/$/, '')
}

function siteShareUrl(token: string | null): string | null {
  return token ? `${siteBase()}/files/site/${token}` : null
}

function publicShareUrl(token: string | null): string | null {
  return token ? `${siteBase()}/files/public/${token}` : null
}

function fileRawUrl(token: string | null): string | null {
  return token ? `${siteBase()}/files/raw/${token}` : null
}

// The links an item's share token yields: sites open raw, docs and files on
// the public page; only files have a raw (embeddable) URL.
function shareLinks(kind: string, token: string | null): { share_url: string | null, raw_url: string | null } {
  return {
    share_url: kind === 'site' ? siteShareUrl(token) : publicShareUrl(token),
    raw_url: kind === 'file' ? fileRawUrl(token) : null
  }
}

const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024
const UPLOAD_URL_TTL_SECONDS = 3600

// Storage-key segment scoping MCP uploads to the transaction's org (the
// tenancy GUC); single-tenant deploys have no org and use a fixed segment.
async function uploadOrgSegment(tx: Transaction<Database>): Promise<string> {
  const { rows } = await sql<{ org: string | null }>`
    select nullif(current_setting('app.current_org', true), '') as org
  `.execute(tx)
  return rows[0]?.org ?? 'default'
}

function fileExtension(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : 'bin'
}

function textResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {})
  }
}

// ─── Read tools ─────────────────────────────────────────────────────────────

export const listFilesTool = defineMcpTool({
  name: 'files_list',
  title: 'List Files',
  description: 'List documents, sites, and uploaded files in the active org, newest first. '
    + 'Shared items include share_url, and shared files a raw_url (both null when unshared).',
  scope: 'files.read',
  input: z.object({
    org: orgInput,
    kind: z.enum(['doc', 'file', 'site']).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict(),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50
    return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
      let qb = tx
        .selectFrom('files_items as f')
        .leftJoin('users as u', 'u.id', 'f.created_by')
        .select([
          'f.id', 'f.kind', 'f.title', 'f.filename', 'f.mime', 'f.tags', 'f.share_token',
          'f.created_at', 'u.display_name as created_by_name'
        ])
        .where('f.deleted_at', 'is', null)
        .orderBy('f.created_at', 'desc')
        .limit(limit)
      if (input.kind) qb = qb.where('f.kind', '=', input.kind)

      const rows = await qb.execute()
      return textResult(`${rows.length} item(s)`, {
        items: rows.map(r => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          filename: r.filename,
          mime: r.mime,
          tags: r.tags,
          ...shareLinks(r.kind, r.share_token),
          created_by_name: r.created_by_name,
          created_at: (r.created_at as Date).toISOString()
        }))
      })
    })
  }
})

export const readDocTool = defineMcpTool({
  name: 'files_read_doc',
  title: 'Read Document',
  description: 'Read a single document, returning its markdown body.',
  scope: 'files.read',
  input: z.object({ org: orgInput, id: z.string().uuid() }).strict(),
  handler: async (input, ctx) => {
    return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
      const item = await loadItem(tx, input.id)
      if (!item) throw createError({ statusCode: 404, statusMessage: 'Document not found.' })
      if (item.kind !== 'doc') {
        throw createError({ statusCode: 400, statusMessage: 'Not a document.' })
      }
      return textResult(`Document "${item.title}"`, {
        id: item.id,
        title: item.title,
        body_md: item.body_md ?? '',
        tags: item.tags
      })
    })
  }
})

export const readSiteTool = defineMcpTool({
  name: 'files_read_site',
  title: 'Read Site',
  description: 'Read a single site, returning its self-contained HTML and public share URL (null when not shared).',
  scope: 'files.read',
  input: z.object({ org: orgInput, id: z.string().uuid() }).strict(),
  handler: async (input, ctx) => {
    return await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
      const item = await loadItem(tx, input.id)
      if (!item) throw createError({ statusCode: 404, statusMessage: 'Site not found.' })
      if (item.kind !== 'site') {
        throw createError({ statusCode: 400, statusMessage: 'Not a site.' })
      }
      return textResult(`Site "${item.title}"`, {
        id: item.id,
        title: item.title,
        html: item.body_md ?? '',
        tags: item.tags,
        share_url: siteShareUrl(item.share_token)
      })
    })
  }
})

// ─── Write tools ────────────────────────────────────────────────────────────

export const createDocTool = defineMcpTool({
  name: 'files_create_doc',
  title: 'Create Document',
  description: 'Create a new markdown document in the active org.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    title: z.string().min(1).max(500),
    body_md: z.string().max(MAX_DOC_BYTES).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const bodyMd = input.body_md ?? ''
        // z.string().max() caps UTF-16 units, not bytes — enforce the real
        // byte cap here so MCP matches the REST create + saveDocContent paths.
        if (Buffer.byteLength(bodyMd, 'utf8') > MAX_DOC_BYTES) {
          throw createError({ statusCode: 413, statusMessage: 'Document content exceeds 100KB limit.' })
        }
        const tags = [...new Set((input.tags ?? []).map(t => t.trim()).filter(Boolean))]
        const item = await tx
          .insertInto('files_items')
          .values({
            kind: 'doc',
            title: input.title.trim(),
            body_md: bodyMd,
            tags,
            created_by: ctx.auth.userId,
            last_edited_by: ctx.auth.userId,
            last_edited_at: sql<Date>`now()`
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow()

        await tx.insertInto('files_versions')
          .values({ item_id: item.id, title: input.title.trim(), content: bodyMd, edited_by: ctx.auth.userId })
          .execute()

        await mcpLog('CREATE', 'files_items', item.id, ctx, { kind: 'doc' }, asAuditExecutor(tx))
        return { id: item.id }
      })
      return textResult(`Created document ${result.id}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const updateDocTool = defineMcpTool({
  name: 'files_update_doc',
  title: 'Update Document',
  description: 'Update a document\'s title and/or markdown body. Creates a new version snapshot.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    id: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    body_md: z.string().max(MAX_DOC_BYTES).optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const item = await loadItem(tx, input.id)
        if (!item) throw createError({ statusCode: 404, statusMessage: 'Document not found.' })
        if (item.kind !== 'doc') {
          throw createError({ statusCode: 400, statusMessage: 'Not a document.' })
        }
        const { versionId } = await saveDocContent(tx, input.id, {
          title: input.title?.trim() ?? item.title,
          body_md: input.body_md ?? item.body_md ?? ''
        }, ctx.auth.userId)

        await mcpLog('UPDATE', 'files_items', input.id, ctx, { version_id: versionId }, asAuditExecutor(tx))
        return { id: input.id, version_id: versionId }
      })
      return textResult(`Updated document ${result.id}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const createSiteTool = defineMcpTool({
  name: 'files_create_site',
  title: 'Create Site',
  description: 'Create a new site: an HTML page (inline CSS/JS/images) in the active org. '
    + 'It may also reference shared files by their raw_url (<video src>, <img src>, '
    + '<a href="<raw_url>?download=1"> for a download), and outside resources such as fonts '
    + 'and CDN scripts load normally. '
    + 'Set share=true to issue a public link; the page is served in a sandboxed, opaque origin.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    title: z.string().min(1).max(500),
    html: z.string().max(MAX_SITE_BYTES).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    share: z.boolean().optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const html = input.html ?? ''
        if (Buffer.byteLength(html, 'utf8') > MAX_SITE_BYTES) {
          throw createError({ statusCode: 413, statusMessage: 'Site content exceeds 2MB limit.' })
        }
        const tags = [...new Set((input.tags ?? []).map(t => t.trim()).filter(Boolean))]
        const item = await tx
          .insertInto('files_items')
          .values({
            kind: 'site',
            title: input.title.trim(),
            body_md: html,
            tags,
            share_token: input.share ? sql<string>`gen_random_uuid()` : null,
            created_by: ctx.auth.userId,
            last_edited_by: ctx.auth.userId,
            last_edited_at: sql<Date>`now()`
          })
          .returning(['id', 'share_token'])
          .executeTakeFirstOrThrow()

        await tx.insertInto('files_versions')
          .values({ item_id: item.id, title: input.title.trim(), content: html, edited_by: ctx.auth.userId })
          .execute()

        await mcpLog('CREATE', 'files_items', item.id, ctx, { kind: 'site', shared: !!input.share }, asAuditExecutor(tx))
        return { id: item.id, share_url: siteShareUrl(item.share_token) }
      })
      return textResult(`Created site ${result.id}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const updateSiteTool = defineMcpTool({
  name: 'files_update_site',
  title: 'Update Site',
  description: 'Replace a site\'s title and/or full HTML. Creates a new version snapshot; '
    + 'changes go live immediately at its share URL. The HTML may reference shared files by '
    + 'their raw_url (<video src>, <img src>, <a href="<raw_url>?download=1">) as well as inline '
    + 'assets; outside resources such as fonts and CDN scripts load normally.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    id: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    html: z.string().max(MAX_SITE_BYTES).optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const item = await loadItem(tx, input.id)
        if (!item) throw createError({ statusCode: 404, statusMessage: 'Site not found.' })
        if (item.kind !== 'site') {
          throw createError({ statusCode: 400, statusMessage: 'Not a site.' })
        }
        const { versionId } = await saveDocContent(tx, input.id, {
          title: input.title?.trim() ?? item.title,
          body_md: input.html ?? item.body_md ?? ''
        }, ctx.auth.userId)

        await mcpLog('UPDATE', 'files_items', input.id, ctx, { version_id: versionId }, asAuditExecutor(tx))
        return { id: input.id, version_id: versionId, share_url: siteShareUrl(item.share_token) }
      })
      return textResult(`Updated site ${result.id}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const beginUploadTool = defineMcpTool({
  name: 'files_begin_upload',
  title: 'Start Upload',
  description: `Start uploading a binary file (max ${MAX_FILE_MB} MB) to the active org. `
    + 'Returns a presigned upload_url. Next: PUT the raw bytes to upload_url with the returned '
    + 'headers (e.g. `curl -X PUT -H \'Content-Type: <mime>\' -T <path> "<upload_url>"`), '
    + 'then call files_complete_upload with the returned key.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    filename: z.string().min(1).max(255),
    mime: z.string().min(1).max(255),
    size_bytes: z.number().int().min(0)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        if (input.size_bytes > MAX_FILE_BYTES) {
          throw createError({ statusCode: 413, statusMessage: `File too large (max ${MAX_FILE_MB} MB).` })
        }
        const key = `files/${await uploadOrgSegment(tx)}/${randomUUID()}.${fileExtension(input.filename)}`
        const uploadUrl = await presignedPutUrl(key, input.mime, UPLOAD_URL_TTL_SECONDS)
        return {
          upload_url: uploadUrl,
          key,
          expires_at: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
          method: 'PUT',
          headers: { 'Content-Type': input.mime }
        }
      })
      return textResult(`PUT the file to upload_url, then call files_complete_upload with key ${result.key}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const completeUploadTool = defineMcpTool({
  name: 'files_complete_upload',
  title: 'Finish Upload',
  description: 'Finish an upload started with files_begin_upload, after the bytes were PUT to its upload_url. '
    + 'Creates the file item. Set share=true to issue a public link; the result\'s raw_url can be '
    + 'embedded in a site (<video src>, <img src>, or <a href="<raw_url>?download=1">).',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    key: z.string().min(1).max(512),
    filename: z.string().min(1).max(255),
    title: z.string().min(1).max(500).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    share: z.boolean().optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const prefix = `files/${await uploadOrgSegment(tx)}/`
        if (!input.key.startsWith(prefix) || !/^[0-9a-f-]{36}\.[a-z0-9]{1,16}$/.test(input.key.slice(prefix.length))) {
          throw createError({ statusCode: 400, statusMessage: 'Key was not issued for this org by files_begin_upload.' })
        }
        const existing = await tx.selectFrom('files_items').select('id')
          .where('storage_key', '=', input.key).executeTakeFirst()
        if (existing) {
          throw createError({ statusCode: 409, statusMessage: 'This upload was already completed.' })
        }
        const stat = await statS3Object(input.key)
        if (!stat) {
          throw createError({ statusCode: 404, statusMessage: 'No uploaded object at that key. PUT the file to upload_url first.' })
        }
        if (stat.size > MAX_FILE_BYTES) {
          await deleteFromS3(input.key)
          throw createError({ statusCode: 413, statusMessage: `File too large (max ${MAX_FILE_MB} MB).` })
        }

        const filename = input.filename.trim()
        const mime = stat.contentType || 'application/octet-stream'
        const tags = [...new Set((input.tags ?? []).map(t => t.trim()).filter(Boolean))]
        const item = await tx
          .insertInto('files_items')
          .values({
            kind: 'file',
            title: input.title?.trim() || filename,
            storage_key: input.key,
            filename,
            mime,
            size_bytes: stat.size,
            tags,
            share_token: input.share ? sql<string>`gen_random_uuid()` : null,
            created_by: ctx.auth.userId
          })
          .returning(['id', 'share_token'])
          .executeTakeFirstOrThrow()

        await mcpLog('CREATE', 'files_items', item.id, ctx, { kind: 'file', mime, shared: !!input.share }, asAuditExecutor(tx))
        return { id: item.id, ...shareLinks('file', item.share_token) }
      })
      return textResult(`Created file ${result.id}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const shareTool = defineMcpTool({
  name: 'files_share',
  title: 'Share Publicly',
  description: 'Issue a public link for a document, site, or file. Returns the existing link when the item '
    + 'is already shared; reissue=true replaces it, which breaks every page that embeds the old link. '
    + 'Files also get a raw_url to embed in a site.',
  scope: 'files.write',
  input: z.object({
    org: orgInput,
    id: z.string().uuid(),
    reissue: z.boolean().optional()
  }).strict(),
  handler: async (input, ctx) => {
    try {
      const result = await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const item = await loadItem(tx, input.id)
        if (!item) throw createError({ statusCode: 404, statusMessage: 'Not found.' })
        if (item.share_token && !input.reissue) {
          return shareLinks(item.kind, item.share_token)
        }
        const updated = await tx
          .updateTable('files_items')
          .set({ share_token: sql<string>`gen_random_uuid()` })
          .where('id', '=', input.id)
          .returning('share_token')
          .executeTakeFirstOrThrow()

        await mcpLog('UPDATE', 'files_items', input.id, ctx, { action: 'share_issued' }, asAuditExecutor(tx))
        return shareLinks(item.kind, updated.share_token)
      })
      return textResult(`Shared: ${result.share_url}`, result)
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const unshareTool = defineMcpTool({
  name: 'files_unshare',
  title: 'Stop Sharing',
  description: 'Revoke an item\'s public link. New loads fail immediately; a file already loaded through '
    + `its raw_url can keep working for up to ${RAW_LINK_TTL_SECONDS / 60} minutes.`,
  scope: 'files.write',
  input: z.object({ org: orgInput, id: z.string().uuid() }).strict(),
  handler: async (input, ctx) => {
    try {
      await runInOrgTransaction(ctx.event, { org: input.org, userId: ctx.auth.userId }, async (tx) => {
        const item = await loadItem(tx, input.id)
        if (!item) throw createError({ statusCode: 404, statusMessage: 'Not found.' })
        await tx
          .updateTable('files_items')
          .set({ share_token: null })
          .where('id', '=', input.id)
          .execute()
        await mcpLog('UPDATE', 'files_items', input.id, ctx, { action: 'share_revoked' }, asAuditExecutor(tx))
      })
      return textResult('Share link revoked', { ok: true })
    } catch (err) {
      return mcpError(err)
    }
  }
})

export const filesMcpTools = [
  listFilesTool,
  readDocTool,
  readSiteTool,
  createDocTool,
  updateDocTool,
  createSiteTool,
  updateSiteTool,
  beginUploadTool,
  completeUploadTool,
  shareTool,
  unshareTool
]
