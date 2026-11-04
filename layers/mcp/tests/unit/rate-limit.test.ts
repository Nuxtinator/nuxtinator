import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import {
  DEFAULT_RATE_LIMITS,
  resolveRateLimitConfig,
  __resetRateLimitConfigForTests,
  checkBuckets
} from '../../server/utils/mcp-rate-limit'
import { defineMcpTool } from '../../server/mcp-layer/define'
import type { McpToolContext } from '../../server/mcp-layer/define'
import type { BearerAuth } from '../stubs/server/utils/oauth-bearer'
import { setTestRuntimeConfig, getTestStorage } from '../stubs/nitro-globals'

const baseAuth: BearerAuth = {
  userId: 'u1',
  clientId: 'c1',
  scopes: ['pages.view', 'pages.write'],
  tokenId: 't1',
  familyId: 'f1'
}

function makeCtx(toolName: string, scope: BearerAuth['scopes'][number]): McpToolContext {
  const tool = defineMcpTool({
    name: toolName,
    description: '',
    scope: scope as 'pages.view',
    input: z.object({}),
    handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
  })
  return {
    auth: baseAuth,
    event: {} as McpToolContext['event'],
    userPermissions: new Set(['pages.view', 'pages.write']),
    tool
  }
}

describe('resolveRateLimitConfig', () => {
  beforeEach(() => {
    __resetRateLimitConfigForTests()
  })

  it('returns the layer defaults when nothing is overridden', () => {
    setTestRuntimeConfig({})
    const cfg = resolveRateLimitConfig()
    expect(cfg).toEqual(DEFAULT_RATE_LIMITS)
  })

  it('applies a partial override and fills missing fields from the default', () => {
    setTestRuntimeConfig({
      mcpRateLimits: {
        allToolsPerToken: { limit: 200 }
      }
    })
    const cfg = resolveRateLimitConfig()
    expect(cfg.allToolsPerToken).toEqual({ limit: 200, windowMs: 60_000 })
    expect(cfg.writesPerToken).toEqual(DEFAULT_RATE_LIMITS.writesPerToken)
  })

  it('disables a bucket when the consumer sets explicit null', () => {
    setTestRuntimeConfig({
      mcpRateLimits: {
        destructivePerUser: null
      }
    })
    const cfg = resolveRateLimitConfig()
    expect(cfg.destructivePerUser).toBeNull()
  })

  it('caches the resolved config across calls', () => {
    setTestRuntimeConfig({ mcpRateLimits: { allToolsPerToken: { limit: 50, windowMs: 60_000 } } })
    const a = resolveRateLimitConfig()
    setTestRuntimeConfig({}) // change after first resolve
    const b = resolveRateLimitConfig()
    expect(a).toBe(b)
    expect(b.allToolsPerToken?.limit).toBe(50)
  })
})

describe('checkBuckets', () => {
  beforeEach(() => {
    __resetRateLimitConfigForTests()
    getTestStorage().clear()
  })

  it('allows a request under the per-token limit', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: { allToolsPerToken: { limit: 5, windowMs: 60_000 }, writesPerToken: null, destructivePerUser: null }
    })
    const ctx = makeCtx('list_pages', 'pages.view')
    const result = await checkBuckets(ctx.tool, ctx)
    expect(result).toBeNull()
  })

  it('rejects when the all-tools bucket is exhausted', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: { allToolsPerToken: { limit: 2, windowMs: 60_000 }, writesPerToken: null, destructivePerUser: null }
    })
    const ctx = makeCtx('a', 'pages.view')

    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    const blocked = await checkBuckets(ctx.tool, ctx)
    expect(blocked).not.toBeNull()
    expect(blocked!.bucket).toBe('all')
    expect(blocked!.allowed).toBe(false)
  })

  it('treats a tool whose scope is in mcpReadScopes as read-only (no writes bucket)', async () => {
    setTestRuntimeConfig({
      mcpReadScopes: ['pages.view'],
      mcpRateLimits: {
        allToolsPerToken: null,
        writesPerToken: { limit: 1, windowMs: 60_000 },
        destructivePerUser: null
      }
    })
    const ctx = makeCtx('list_pages', 'pages.view')

    // Even after exceeding the writes limit count, a read tool isn't subject to the writes bucket.
    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
  })

  it('treats a readOnly tool as read-only whatever its scope (no writes bucket)', async () => {
    setTestRuntimeConfig({
      mcpReadScopes: [],
      mcpRateLimits: {
        allToolsPerToken: null,
        writesPerToken: { limit: 1, windowMs: 60_000 },
        destructivePerUser: null
      }
    })
    const ctx = makeCtx('list_pages', 'pages.write')
    ctx.tool = { ...ctx.tool, readOnly: true }

    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
  })

  it('counts a write tool against the writes-per-token bucket', async () => {
    setTestRuntimeConfig({
      mcpReadScopes: [],
      mcpRateLimits: {
        allToolsPerToken: null,
        writesPerToken: { limit: 1, windowMs: 60_000 },
        destructivePerUser: null
      }
    })
    const ctx = makeCtx('create_page', 'pages.write')

    expect(await checkBuckets(ctx.tool, ctx)).toBeNull()
    const blocked = await checkBuckets(ctx.tool, ctx)
    expect(blocked).not.toBeNull()
    expect(blocked!.bucket).toBe('writes')
  })

  it('routes destructive tools through the destructive-per-user bucket', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: {
        allToolsPerToken: null,
        writesPerToken: null,
        destructivePerUser: { limit: 1, windowMs: 60 * 60_000 }
      }
    })
    const tool = defineMcpTool({
      name: 'delete_page',
      description: '',
      scope: 'pages.write',
      destructive: true,
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    const ctx: McpToolContext = {
      auth: baseAuth,
      event: {} as McpToolContext['event'],
      userPermissions: new Set(['pages.write']),
      tool
    }

    expect(await checkBuckets(tool, ctx)).toBeNull()
    const blocked = await checkBuckets(tool, ctx)
    expect(blocked).not.toBeNull()
    expect(blocked!.bucket).toBe('destructive')
  })

  it('honors a per-tool rateLimit override on top of defaults', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: {
        allToolsPerToken: { limit: 1000, windowMs: 60_000 },
        writesPerToken: null,
        destructivePerUser: null
      }
    })
    const tool = defineMcpTool({
      name: 'expensive_thing',
      description: '',
      scope: 'pages.view',
      input: z.object({}),
      rateLimit: { limit: 1, windowMs: 60_000, keyBy: 'token' },
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    const ctx: McpToolContext = {
      auth: baseAuth,
      event: {} as McpToolContext['event'],
      userPermissions: new Set(['pages.view']),
      tool
    }

    expect(await checkBuckets(tool, ctx)).toBeNull()
    const blocked = await checkBuckets(tool, ctx)
    expect(blocked).not.toBeNull()
    expect(blocked!.bucket).toBe('tool:expensive_thing')
  })

  it('does not consume any bucket when a per-tool bucket fails (no double-charging)', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: {
        allToolsPerToken: { limit: 5, windowMs: 60_000 },
        writesPerToken: null,
        destructivePerUser: null
      }
    })
    const tool = defineMcpTool({
      name: 'one_per_minute',
      description: '',
      scope: 'pages.view',
      input: z.object({}),
      rateLimit: { limit: 1, windowMs: 60_000, keyBy: 'token' },
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    const ctx: McpToolContext = {
      auth: baseAuth,
      event: {} as McpToolContext['event'],
      userPermissions: new Set(['pages.view']),
      tool
    }

    // First call passes both buckets; allTools count = 1, tool count = 1.
    expect(await checkBuckets(tool, ctx)).toBeNull()
    // Second call: per-tool fails with limit=1, dry-run stage rejects.
    // The all-tools count must still be 1 — not 2 — since dispatcher rejected
    // before incrementing.
    const blocked = await checkBuckets(tool, ctx)
    expect(blocked).not.toBeNull()

    // We can verify allTools didn't get charged by trying 4 more calls
    // against just the all-tools bucket via a different (no per-tool) tool.
    const cheapTool = defineMcpTool({
      name: 'cheap',
      description: '',
      scope: 'pages.view',
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    const cheapCtx: McpToolContext = {
      auth: baseAuth,
      event: {} as McpToolContext['event'],
      userPermissions: new Set(['pages.view']),
      tool: cheapTool
    }
    // allTools count after the test above should be 1; we have 4 more before exhausting limit=5.
    expect(await checkBuckets(cheapTool, cheapCtx)).toBeNull()
    expect(await checkBuckets(cheapTool, cheapCtx)).toBeNull()
    expect(await checkBuckets(cheapTool, cheapCtx)).toBeNull()
    expect(await checkBuckets(cheapTool, cheapCtx)).toBeNull()
    expect(await checkBuckets(cheapTool, cheapCtx)).not.toBeNull()
  })

  it('produces a retryAfterSeconds within the window', async () => {
    setTestRuntimeConfig({
      mcpRateLimits: { allToolsPerToken: { limit: 1, windowMs: 60_000 }, writesPerToken: null, destructivePerUser: null }
    })
    const ctx = makeCtx('a', 'pages.view')
    await checkBuckets(ctx.tool, ctx)
    const blocked = await checkBuckets(ctx.tool, ctx)
    expect(blocked!.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked!.retryAfterSeconds).toBeLessThanOrEqual(60)
  })
})
