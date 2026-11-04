import { z } from 'zod'
import { defineMcpTool, mcpError, mcpLog } from '#mcp-layer'
import { db } from '#core/server/utils/database'

// Read tool — `pages.view` is in mcpReadScopes so this skips the writes bucket.
export const listPagesTool = defineMcpTool({
  name: 'list_pages',
  title: 'List Pages',
  description: 'List pages from the fixture DB.',
  scope: 'pages.view',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(10)
  }).strict(),
  output: z.object({
    count: z.number()
  }),
  handler: async (input, _ctx) => {
    return {
      content: [{ type: 'text' as const, text: `would list up to ${input.limit} pages` }],
      structuredContent: { count: 0 }
    }
  }
})

// Write tool — emits an activity_logs row via mcpLog.
export const createPageTool = defineMcpTool({
  name: 'create_page',
  description: 'Create a fake page row (writes activity_logs).',
  scope: 'pages.write',
  input: z.object({
    slug: z.string().min(1).max(100)
  }).strict(),
  handler: async (input, ctx) => {
    try {
      // No real `pages` table in the fixture — we just emit the audit row.
      await mcpLog('CREATE', 'pages', input.slug, ctx, { slug: input.slug })
      return { content: [{ type: 'text' as const, text: `created ${input.slug}` }] }
    }
    catch (err) {
      return mcpError(err)
    }
  }
})

// Destructive tool — flips the destructive bucket.
export const deletePageTool = defineMcpTool({
  name: 'delete_page',
  description: 'Delete a fake page (destructive).',
  scope: 'pages.write',
  destructive: true,
  input: z.object({ slug: z.string().min(1) }).strict(),
  handler: async (input, ctx) => {
    await mcpLog('DELETE', 'pages', input.slug, ctx, { slug: input.slug })
    return { content: [{ type: 'text' as const, text: `deleted ${input.slug}` }] }
  }
})

// Tool with output schema — used to test malformed-output detection.
// When called with `{ malformed: true }` it returns structuredContent that
// fails the output schema, so the dispatcher must convert it to a generic
// isError instead of leaking the bad payload.
export const outputCheckTool = defineMcpTool({
  name: 'output_check',
  description: 'Returns either valid or malformed structuredContent depending on input.',
  scope: 'pages.view',
  input: z.object({ malformed: z.boolean().default(false) }).strict(),
  output: z.object({ ok: z.boolean(), value: z.number() }),
  handler: async (input) => {
    if (input.malformed) {
      // structuredContent that violates the output schema (value should be a number).
      return {
        content: [{ type: 'text' as const, text: 'oops' }],
        structuredContent: { ok: true, value: 'not-a-number' as unknown as number }
      }
    }
    return {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { ok: true, value: 1 }
    }
  }
})

// Tool with a tight per-tool rate limit — used to test the per-tool bucket.
export const expensiveTool = defineMcpTool({
  name: 'expensive_thing',
  description: 'One call per minute per token.',
  scope: 'pages.view',
  input: z.object({}).strict(),
  rateLimit: { limit: 1, windowMs: 60_000, keyBy: 'token' },
  handler: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }]
  })
})

// Tool that always throws — used to test mcpError mapping at the boundary.
export const failingTool = defineMcpTool({
  name: 'failing_tool',
  description: 'Always throws an h3 404.',
  scope: 'pages.view',
  input: z.object({}).strict(),
  handler: async () => {
    throw createError({ statusCode: 404, statusMessage: 'gone', data: { entity: 'page' } })
  }
})
