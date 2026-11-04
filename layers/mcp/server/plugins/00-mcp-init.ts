import { createRequire } from 'node:module'
import { getRegistry } from '../mcp-layer/registry'
import { DEFAULT_RATE_LIMITS, resolveRateLimitConfig } from '../utils/mcp-rate-limit'
import { compareVersions } from '../utils/mcp-semver'

const require = createRequire(import.meta.url)

// Initializes nitroApp.mcpRegistry. Must run before any project/downstream-layer
// plugin that calls `nitroApp.mcpRegistry.register(...)`. Nuxt auto-loads
// plugins in numeric-prefix order, so 00- runs before 10-, 20-, etc.
export default defineNitroPlugin((nitroApp) => {
  // Backed by a module-level singleton so consumer plugins that run in any
  // order across layers can `register(...)` against a stable instance.
  nitroApp.mcpRegistry = getRegistry()

  // Boot-time SDK version assertion. The layer's correctness claims rely on
  // the SDK enforcing the MCP-Protocol-Version header and 405-on-GET in
  // stateless mode (both shipped from 1.20.0). Skipped silently when the
  // SDK package.json isn't reachable from the runtime's resolution graph
  // (Nitro bundles the entry as `/_entry.js` so CJS require can't always
  // walk up to find it). Production builds should run `bun pm pkg get
  // dependencies.@modelcontextprotocol/sdk` in CI to verify the floor
  // out-of-band — the runtime check is defense in depth.
  const FLOOR = '1.20.0'
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdkPkg = require('@modelcontextprotocol/sdk/package.json')
    const installed = sdkPkg?.version
    // Skip silently when the require returned an unexpected shape (e.g.
    // a Vite-stub object in dev mode, or a package.json without a version
    // field). The floor check is defense-in-depth; CI verifies out-of-band.
    if (typeof installed === 'string' && installed.length > 0) {
      if (compareVersions(installed, FLOOR) < 0) {
        throw new Error(
          `[mcp-layer] @modelcontextprotocol/sdk ${installed} is below required floor ${FLOOR}. `
          + `Upgrade with: bun add @modelcontextprotocol/sdk@^${FLOOR}`
        )
      }
    }
  }
  catch (err) {
    // Re-throw the deliberate floor-violation error.
    if (err instanceof Error && err.message.startsWith('[mcp-layer]')) throw err
    // Everything else (module-not-found in bundled Nitro, package.json
    // shape mismatches in dev) is a non-fatal "couldn't verify" — silent.
  }

  // Pre-resolve the rate-limit config (deep-merge override + defaults) so
  // runtime hits the cached value.
  resolveRateLimitConfig()

  // Every layer's plugins have registered by the first request, so a disabled
  // entry still unmatched then names no loaded app or tool.
  nitroApp.hooks.hookOnce('request', () => {
    const { apps, tools } = getRegistry().unmatchedDisabled()
    if (apps.length > 0) console.warn(`[mcp-layer] mcpDisabledApps lists apps with no MCP tools or resources: ${apps.join(', ')}`)
    if (tools.length > 0) console.warn(`[mcp-layer] mcpDisabledTools lists unknown tools: ${tools.join(', ')}`)
  })

  // Cache-driver warning: production + memory driver = per-process buckets,
  // not deployment-wide. Operators see the line and decide whether to act.
  if (process.env.NODE_ENV === 'production') {
    try {
      const storage = useStorage('cache')
      const driver = (storage as unknown as { driver?: { name?: string } }).driver
      const driverName = driver?.name
      if (driverName === 'memory') {
        console.warn(
          '[mcp-layer] cache driver is "memory" — rate-limit buckets are per-process and reset on deploy. '
          + 'Configure a shared driver (Redis, KV, etc.) on the `cache` mount for deployment-wide buckets.'
        )
      }
    }
    catch {
      // ignore — storage may not be ready yet
    }
  }

  // Touch the defaults so unused-import linters don't strip them in projects
  // that re-export this plugin verbatim. No runtime effect.
  void DEFAULT_RATE_LIMITS
})

