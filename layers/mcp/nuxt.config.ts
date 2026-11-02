// MCP layer — turns the consuming project into an MCP server.
// Depends on the OAuth layer; the consuming project must extend BOTH layers
// (OAuth first, then MCP). The MCP layer does not declare `extends:` for OAuth
// here because relative paths in the OAUTH_LAYER_PATH env var resolve from the
// consumer's cwd, not the layer's directory.
//
// Consumer requirements:
// - extends: [OAUTH_LAYER_PATH, MCP_LAYER_PATH] in nuxt.config.ts (in that order).
// - runtimeConfig.public.siteUrl (used to derive the MCP resource URI; OAuth layer normalizes).
// - runtimeConfig.mcpServerName: string (advertised in MCP `initialize` response).
// - runtimeConfig.mcpServerVersion: string (optional; defaults to '1.0.0').
// - runtimeConfig.mcpReadScopes: string[] (optional; tools whose scope is in this list
//   skip the writes-per-token bucket).
// - runtimeConfig.mcpRateLimits: McpRateLimitConfig (optional; deep-merged with defaults).
// - runtimeConfig.mcpAdditionalOrigins: string[] (optional; extra Origin allowlist for
//   browser front-ends served from a different origin than the MCP resource).
// - runtimeConfig.mcpDisabledApps / mcpDisabledTools: string[] (optional; app ids and tool
//   names whose MCP tools and resources are never registered).
// - useStorage('cache') configured. Memory driver is fine for single-replica deployments;
//   multi-replica needs a shared driver (Redis, KV, etc.) for buckets to be deployment-wide.
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  alias: {
    '#mcp-layer': fileURLToPath(new URL('./server/mcp-layer/index.ts', import.meta.url))
  },

  // Exclude layer-private tests from the host typecheck. The layer's own
  // `bun test` runs them with the layer's vitest devDependency in scope —
  // the host project doesn't ship vitest and shouldn't try to type-check
  // these files.
  typescript: {
    tsConfig: {
      exclude: [
        `${layerRoot}tests`,
        `${layerRoot}vitest.config.ts`
      ]
    }
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#mcp-layer': [`${layerRoot}server/mcp-layer/index.ts`]
          }
        },
        exclude: [
          `${layerRoot}tests`,
          `${layerRoot}vitest.config.ts`
        ]
      }
    }
  },

  runtimeConfig: {
    mcpServerName: process.env.MCP_SERVER_NAME || 'My App',
    mcpServerVersion: process.env.MCP_SERVER_VERSION || '1.0.0',
    mcpReadScopes: [] as string[],
    // Empty default; consumers override via their own runtimeConfig.mcpRateLimits.
    // Don't widen this with `as McpRateLimitConfig` — Nuxt's runtime-config
    // type generation forbids `null` in RuntimeValue, and a consumer that
    // sets `{ writesPerToken: { ... } }` would clash with the McpRateLimitConfig
    // union (which permits `null` to disable the bucket). At runtime
    // resolveRateLimitConfig() casts the value back to McpRateLimitConfig
    // before merging with the defaults, so the runtime contract is preserved.
    mcpRateLimits: {},
    mcpAdditionalOrigins: [] as string[],
    mcpDisabledApps: [] as string[],
    mcpDisabledTools: [] as string[]
  }
})
