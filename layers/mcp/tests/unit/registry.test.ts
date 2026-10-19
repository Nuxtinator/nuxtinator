import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { createRegistry } from '../../server/mcp-layer/registry'
import { defineMcpTool, defineMcpResource } from '../../server/mcp-layer/define'

describe('createRegistry', () => {
  let registry: ReturnType<typeof createRegistry>

  beforeEach(() => {
    registry = createRegistry()
  })

  it('registers a tool with valid scope', () => {
    const tool = defineMcpTool({
      name: 'list_pages',
      description: 'List pages',
      scope: 'pages.view',
      input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    })

    registry.register(tool)

    expect(registry.tools).toHaveLength(1)
    expect(registry.tools[0]!.def.name).toBe('list_pages')
  })

  it('registers a tool without a scope', () => {
    const tool = defineMcpTool({
      name: 'list_mine',
      description: 'List the bearer\'s own things',
      input: z.object({}).strict(),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    })

    registry.register(tool)

    expect(registry.tools[0]!.def.scope).toBeUndefined()
  })

  it('rejects a tool whose scope is not in PERMISSIONS', () => {
    const bad = defineMcpTool({
      // @ts-expect-error — testing the runtime guard
      scope: 'not.a.real.scope',
      name: 'bad_tool',
      description: 'x',
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'x' }] })
    })

    expect(() => registry.register(bad)).toThrowError(/not.a.real.scope/)
  })

  it('caches the input JSON Schema at register-time', () => {
    const tool = defineMcpTool({
      name: 'a',
      description: 'a',
      scope: 'pages.view',
      input: z.object({ slug: z.string().min(1) }).strict(),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })

    registry.register(tool)

    const entry = registry.tools[0]!
    expect(entry.inputJsonSchema).toBeDefined()
    expect(entry.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        slug: expect.objectContaining({ type: 'string' })
      })
    })
  })

  it('caches the output JSON Schema when declared', () => {
    const tool = defineMcpTool({
      name: 'a',
      description: 'a',
      scope: 'pages.view',
      input: z.object({}),
      output: z.object({ count: z.number() }),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }], structuredContent: { count: 0 } })
    })

    registry.register(tool)

    const entry = registry.tools[0]!
    expect(entry.outputJsonSchema).toBeDefined()
    expect(entry.outputJsonSchema).toMatchObject({
      type: 'object',
      properties: { count: { type: 'number' } }
    })
  })

  it('throws on duplicate name in production', () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const tool = defineMcpTool({
        name: 'dup',
        description: 'a',
        scope: 'pages.view',
        input: z.object({}),
        handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
      })
      registry.register(tool)
      expect(() => registry.register(tool)).toThrowError(/registered twice/)
    }
    finally {
      process.env.NODE_ENV = original
    }
  })

  it('replaces on duplicate name in dev', () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const t1 = defineMcpTool({
        name: 'dup',
        description: 'first',
        scope: 'pages.view',
        input: z.object({}),
        handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
      })
      const t2 = defineMcpTool({
        name: 'dup',
        description: 'second',
        scope: 'pages.view',
        input: z.object({}),
        handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
      })
      registry.register(t1)
      registry.register(t2)
      expect(registry.tools).toHaveLength(1)
      expect(registry.tools[0]!.def.description).toBe('second')
    }
    finally {
      process.env.NODE_ENV = original
    }
  })

  it('preserves registration order for non-duplicates', () => {
    const a = defineMcpTool({
      name: 'a',
      description: 'a',
      scope: 'pages.view',
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    const b = defineMcpTool({
      name: 'b',
      description: 'b',
      scope: 'pages.view',
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    registry.register(a)
    registry.register(b)

    expect(registry.tools.map(t => t.def.name)).toEqual(['a', 'b'])
  })

  it('registers a resource and rejects bad scope', () => {
    const good = defineMcpResource({
      uriPattern: 'cms://page/{slug}',
      scope: 'pages.view',
      list: async () => [],
      read: async () => ({ contents: [] })
    })
    registry.registerResource(good)
    expect(registry.resources).toHaveLength(1)

    const bad = defineMcpResource({
      uriPattern: 'x://y',
      // @ts-expect-error — testing the runtime guard
      scope: 'not.a.scope',
      list: async () => [],
      read: async () => ({ contents: [] })
    })
    expect(() => registry.registerResource(bad)).toThrowError(/not.a.scope/)
  })

  it('__resetForTests clears tools and resources', () => {
    const t = defineMcpTool({
      name: 'a',
      description: 'a',
      scope: 'pages.view',
      input: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] })
    })
    registry.register(t)
    expect(registry.tools).toHaveLength(1)

    registry.__resetForTests()
    expect(registry.tools).toHaveLength(0)
    expect(registry.resources).toHaveLength(0)

    // Re-registering after reset should also clear the duplicate-name index.
    registry.register(t)
    expect(registry.tools).toHaveLength(1)
  })

  it('__resetForTests refuses to run in production', () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => registry.__resetForTests()).toThrowError(/not callable in production/)
    }
    finally {
      process.env.NODE_ENV = original
    }
  })
})
