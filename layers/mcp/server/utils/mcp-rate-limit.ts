// Sliding-window counters backed by useStorage('cache') (Unstorage).
//
// Window: fixed 60-second buckets keyed on Math.floor(Date.now() / windowMs).
// Simple, fast, no Redis scripting; small bursts at window boundaries are acceptable.
//
// Driver caveat — buckets are per-process unless the cache mount is shared.
// With the memory driver (default), bucket counts reset on deploy and don't
// span replicas. Boot warns when NODE_ENV === 'production' and the cache
// driver is 'memory'.
import type { McpToolDef, McpToolContext } from '../mcp-layer/define'

// The pure-types surface (BucketSpec/BucketResult/McpRateLimitConfig) lives
// in `./mcp-rate-limit-types` so consumer-side `nuxt.config.ts` (loaded via
// tsconfig.node.json, which doesn't carry the `~~/*` path mapping) can
// `import type { McpRateLimitConfig }` without TS following a chain that
// pulls in consumer-rooted paths from define.ts. Importing here is
// type-only; we deliberately don't re-export to avoid Nitro auto-import
// duplicates.
import type { BucketSpec, BucketResult, McpRateLimitConfig } from './mcp-rate-limit-types'

interface BucketEntry {
  count: number
  windowStart: number
}

const NS = 'mcp:rate'

function getCacheStorage() {
  return useStorage('cache')
}

async function consumeBucket(
  bucket: string,
  identifier: string,
  spec: BucketSpec,
  // When `dryRun` is true the bucket is read but not incremented. Used for the
  // initial check across multiple buckets — only after every bucket passes do
  // we increment them, so failing one bucket doesn't consume the others.
  dryRun: boolean = false
): Promise<BucketResult> {
  const storage = getCacheStorage()
  const now = Date.now()
  const windowStart = Math.floor(now / spec.windowMs) * spec.windowMs
  const key = `${NS}:${bucket}:${identifier}`
  const existing = (await storage.getItem<BucketEntry>(key)) ?? null
  const current = existing && existing.windowStart === windowStart ? existing.count : 0
  const next = current + 1
  const allowed = next <= spec.limit
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + spec.windowMs - now) / 1000))

  if (!dryRun && allowed) {
    await storage.setItem(key, { count: next, windowStart }, { ttl: Math.ceil(spec.windowMs / 1000) + 5 })
  }

  return {
    allowed,
    count: next,
    limit: spec.limit,
    windowMs: spec.windowMs,
    retryAfterSeconds,
    bucket
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default bucket configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RATE_LIMITS: Required<McpRateLimitConfig> = {
  allToolsPerToken: { limit: 120, windowMs: 60_000 },
  writesPerToken: { limit: 20, windowMs: 60_000 },
  destructivePerUser: { limit: 20, windowMs: 60 * 60_000 }
}

let _resolvedConfig: McpRateLimitConfig | null = null

// Deep-merge the project's runtime override on top of the layer defaults.
// Rules: missing key → keep default; explicit null → disable; partial → fill.
export function resolveRateLimitConfig(): McpRateLimitConfig {
  if (_resolvedConfig) return _resolvedConfig

  const override: McpRateLimitConfig = useRuntimeConfig().mcpRateLimits ?? {}
  const result: McpRateLimitConfig = { ...DEFAULT_RATE_LIMITS }

  for (const key of ['allToolsPerToken', 'writesPerToken', 'destructivePerUser'] as const) {
    if (key in override) {
      const value = override[key]
      if (value === null) {
        result[key] = null
      }
      else if (value === undefined) {
        // explicit undefined → keep default
        continue
      }
      else {
        result[key] = { ...DEFAULT_RATE_LIMITS[key], ...value }
      }
    }
  }

  _resolvedConfig = result
  return result
}

export function __resetRateLimitConfigForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetRateLimitConfigForTests is not callable in production')
  }
  _resolvedConfig = null
}

// Returns true if the tool is "read-only" for rate-limit purposes. A tool
// counts as read-only iff it declares `readOnly`, its scope is in the
// project's mcpReadScopes list, or it has no scope (scope-less tools are
// read-only by contract).
function isReadTool(tool: McpToolDef<unknown, unknown>): boolean {
  if (tool.readOnly || tool.scope === undefined) return true
  const readScopes = (useRuntimeConfig().mcpReadScopes as string[] | undefined) ?? []
  return readScopes.includes(tool.scope)
}

// Checks the default + per-tool buckets without consuming them. Returns the
// first failing bucket (if any), or null if all pass.
//
// Generics are wide-open so callers can pass tools whose Zod schemas inferred
// narrower I/O types — checkBuckets only inspects scope/name/destructive/
// rateLimit, never input or output payloads.
export async function checkBuckets<I, O>(
  tool: McpToolDef<I, O>,
  ctx: McpToolContext
): Promise<BucketResult | null> {
  const cfg = resolveRateLimitConfig()
  const checks: Array<{ bucket: string; identifier: string; spec: BucketSpec }> = []

  if (cfg.allToolsPerToken) {
    checks.push({ bucket: 'all', identifier: ctx.auth.tokenId, spec: cfg.allToolsPerToken })
  }

  if (!isReadTool(tool as McpToolDef<unknown, unknown>) && cfg.writesPerToken) {
    checks.push({ bucket: 'writes', identifier: ctx.auth.tokenId, spec: cfg.writesPerToken })
  }

  if (tool.destructive && cfg.destructivePerUser) {
    checks.push({ bucket: 'destructive', identifier: ctx.auth.userId, spec: cfg.destructivePerUser })
  }

  if (tool.rateLimit) {
    const identifier
      = tool.rateLimit.keyBy === 'user'
        ? ctx.auth.userId
        : tool.rateLimit.keyBy === 'global'
          ? 'global'
          : ctx.auth.tokenId
    checks.push({
      bucket: `tool:${tool.name}`,
      identifier,
      spec: { limit: tool.rateLimit.limit, windowMs: tool.rateLimit.windowMs }
    })
  }

  // Dry-run all checks first; only increment if every bucket passes.
  for (const c of checks) {
    const result = await consumeBucket(c.bucket, c.identifier, c.spec, /* dryRun */ true)
    if (!result.allowed) return result
  }

  // All passed — consume each bucket.
  for (const c of checks) {
    await consumeBucket(c.bucket, c.identifier, c.spec, /* dryRun */ false)
  }

  return null
}
