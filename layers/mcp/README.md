# MCP Layer

Reusable Nuxt layer that turns a project into an [MCP](https://modelcontextprotocol.io/) server. Ships:

- `/mcp` HTTP transport (Streamable HTTP, **stateless, POST-only**).
- `defineMcpTool` / `defineMcpResource` registration API for tools and resources.
- Bearer-token integration via the OAuth layer (audience match, token revocation, RBAC enforcement, `tools/list` filtering).
- Zod input validation, JSON Schema projection, body-size cap (2 MB), Origin / protocol-version checks.
- Sliding-window rate-limit buckets backed by `useStorage('cache')`.
- Activity-log integration via direct import of the consumer's `logEvent`.

The layer ships **zero tools in production**. Consumer projects register their own.

## Layer dependencies

```
project (consumer)
  └─ extends mcp-layer
       └─ depends on oauth-layer (consumer must extend BOTH)
            └─ extends nuxt-base (DB, activity_logs, etc.)
```

The MCP layer does not declare `extends:` for the OAuth layer in its own `nuxt.config.ts` — relative paths in `OAUTH_LAYER_PATH` resolve from the consumer's cwd, not from the layer's directory. The consumer must extend **both** layers in order:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  extends: [
    process.env.OAUTH_LAYER_PATH,
    process.env.MCP_LAYER_PATH
  ].filter(Boolean) as string[]
})
```

## Required consumer config

```ts
// nuxt.config.ts
runtimeConfig: {
  // Required
  mcpServerName: process.env.MCP_SERVER_NAME || 'my-app',
  mcpServerVersion: process.env.MCP_SERVER_VERSION || '1.0.0',

  // Optional
  mcpReadScopes: ['pages.view', 'users.view'],   // tools with these scopes skip the writes-per-token bucket
  mcpRateLimits: {                                // deep-merged with layer defaults
    allToolsPerToken: { limit: 200, windowMs: 60_000 },
    destructivePerUser: null                      // explicit null disables a bucket
  },
  mcpAdditionalOrigins: ['https://admin.example.com']
}
```

The OAuth layer reads `runtimeConfig.public.siteUrl` to derive `mcpResource = ${siteUrl}/mcp`. Tokens minted with that resource are accepted at the `/mcp` endpoint.

## Defining a tool

```ts
// server/mcp/tools/list-pages.ts
import { z } from 'zod'
import { defineMcpTool, mcpError } from '#mcp-layer'
import { db } from '~~/server/utils/database'

export const listPagesTool = defineMcpTool({
  name: 'list_pages',
  title: 'List Pages',
  description: 'List CMS pages.',
  scope: 'pages.view',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20)
  }).strict(),
  output: z.object({
    pages: z.array(z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string()
    }))
  }),
  handler: async (input, ctx) => {
    try {
      const rows = await db
        .selectFrom('pages')
        .select(['id', 'slug', 'title'])
        .limit(input.limit)
        .execute()

      return {
        content: [{ type: 'text', text: `Found ${rows.length} pages.` }],
        structuredContent: { pages: rows }
      }
    }
    catch (err) {
      return mcpError(err)
    }
  }
})
```

Register the tool from a Nitro plugin:

```ts
// server/plugins/10-mcp-cms.ts
import { listPagesTool } from '../mcp/tools/list-pages'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.mcpRegistry.register(listPagesTool)
})
```

The numeric `10-` prefix ensures this plugin runs after the layer's `00-mcp-init.ts`.

## Defining a resource

```ts
import { defineMcpResource } from '#mcp-layer'
import { db } from '~~/server/utils/database'

export const cmsPageResource = defineMcpResource({
  uriPattern: 'cms://page/{slug}/{locale}',
  scope: 'pages.view',
  list: async () => {
    const rows = await db.selectFrom('pages').select(['slug']).execute()
    return rows.flatMap(row => ['en', 'es', 'fr'].map(locale => ({
      uri: `cms://page/${row.slug}/${locale}`,
      name: `${row.slug} (${locale})`,
      mimeType: 'application/json'
    })))
  },
  read: async (uri) => {
    // ... fetch, return { contents: [{ uri, mimeType, text }] }
  }
})
```

```ts
// server/plugins/10-mcp-cms.ts
nitroApp.mcpRegistry.registerResource(cmsPageResource)
```

## Audit logging

Write tools should emit an audit row. The layer ships a thin wrapper that adds the standard MCP metadata (`source: 'mcp'`, `client_id`, `tool`, `scope`, `user_id`):

```ts
import { mcpLog } from '#mcp-layer'

// non-transactional
await mcpLog('UPDATE', 'pages', page.id, ctx, { changedFields })

// transactional — pass the executor so the audit row commits with the data write
await db.transaction().execute(async (tx) => {
  const page = await tx.insertInto('pages').values(...).returningAll().executeTakeFirstOrThrow()
  await mcpLog('CREATE', 'pages', page.id, ctx, { slug: page.slug }, tx)
})
```

`mcpLog` always passes `ctx.auth.userId` (string), never `ctx.event` — MCP requests carry a bearer token, not the admin auth-token cookie that `getAuthUser(event)` reads.

## Authorization model — three gates

A `tools/call` invocation must pass:

1. **Bearer valid** — token + audience + family + client-enabled (transport boundary, via `requireValidBearer`).
2. **Token scope includes `tool.scope`** — `auth.scopes.includes(tool.scope)`. Failure → `isError` with `structuredContent: { error: 'insufficient_scope', surface: 'token', actionable: 're_authorize' }`.
3. **User holds `tool.scope` as RBAC permission in the org the call targets** — resolved per call by the `#tenant/server` kernel's `getUserPermissionsForRequest(event, userId, { org })`, where `org` is the tool's `org` input, else the request's `X-Active-Org` header. Membership roles and direct grants in that org count, as do host-level roles and `is_admin`. Failure → `isError` with `structuredContent: { error: 'insufficient_permission', surface: 'rbac', actionable: 'contact_admin' }`.

Gates 2 and 3 reference the same string but check different surfaces. A user demoted in RBAC mid-session loses access immediately even with a valid token; reauthorization won't help — only an admin granting the permission will.

`tools/list` filters by gate 2 and by the union of the user's permissions across every org they belong to (`getUserPermissionsAcrossOrgs`), so the model only sees tools it can call somewhere; the per-org check is gate 3 at call time.

## Org selection in multi-tenant mode

When the tenancy layer is loaded, every tool that touches org-scoped data accepts an optional `org` input: the slug of the org to operate in (the context layer's `list_orgs` returns the bearer's memberships). Without it the tool falls back to the request's `X-Active-Org` header, so a client pinned to one org through a fixed header keeps working. Either way the tool runs inside `runInOrgTransaction(event, { org, userId }, ...)` from `#tenant/server`, which rejects an org the bearer's user is not a member of (404, indistinguishable from a non-existent org), a suspended org (423), and a call that names no org at all (400).

A tool opts in by adding an `org` field to its Zod input and passing `{ org: input.org, userId: ctx.auth.userId }` as the second argument; the single-mode kernel accepts the option and ignores it.

## Rate limits

Three default buckets, all overridable via `runtimeConfig.mcpRateLimits`:

| Bucket | Key | Default | Window |
|---|---|---|---|
| All tools | `auth.tokenId` | 120 | 60s |
| Write tools (scope ∉ `mcpReadScopes`) | `auth.tokenId` | 20 | 60s |
| Destructive tools (`destructive: true`) | `userId` | 20 | 1h |

Per-tool overrides are **additive** — they layer on top of the defaults:

```ts
defineMcpTool({
  name: 'expensive_thing',
  // ...
  rateLimit: { limit: 1, windowMs: 60_000, keyBy: 'user' }
})
```

Limit-exceeded responses go through the `isError` channel (not HTTP 429) so the JSON-RPC envelope stays intact and clients back off naturally.

**Driver caveat**: with the `memory` cache driver (Nuxt default), buckets are per-process. Multi-replica deployments need a shared driver (Redis, KV, etc.) on the `cache` mount. The layer logs a warning at boot when `NODE_ENV === 'production'` and the driver name is `'memory'`.

## Permissions catalog

The layer reads the consumer project's `app/utils/permissions.ts` directly. `tool.scope` must be a member of the consumer's `PERMISSIONS` array — the registry's boot-time `isPermission(tool.scope)` check rejects unknown scopes with a clear error pointing at the offending name. The OAuth layer uses the same source — there is no separate scope catalog, no drift.

## MCP Inspector dev loop

```bash
npx @modelcontextprotocol/inspector
# point at http://localhost:3033/mcp with a bearer token from the dev OAuth flow
```

Run the consumer's dev OAuth flow first, copy the issued access token, and paste it as the bearer token in Inspector.

## File layout

```
mcp-layer/
  server/
    routes/
      mcp.ts                    # Transport entry point
    plugins/
      00-mcp-init.ts            # Initializes nitroApp.mcpRegistry, SDK floor check, cache warning
    mcp-layer/
      server.ts                 # buildMcpServer({ auth, event }) + dispatcher
      registry.ts               # createRegistry()
      define.ts                 # defineMcpTool, defineMcpResource, types
      errors.ts                 # mcpError mapper
      index.ts                  # #mcp-layer barrel
    utils/
      mcp-origin.ts             # assertAllowedOrigin
      mcp-rate-limit.ts         # buckets, default config, override merge
      mcp-audit.ts              # mcpLog wrapper
      mcp-validate.ts           # validateInput
    types.d.ts                  # NitroApp module augmentation for mcpRegistry
  nuxt.config.ts                # alias #mcp-layer, runtimeConfig
  package.json
```

## Tests

```bash
cd base-code/layers/mcp
npm install   # or bun install — one-time
TEST_DATABASE_URL=postgres://<user>@localhost:5432/mcp_layer_test \
NUXT_PUBLIC_SITE_URL=http://localhost:3099 \
npm test
```

64 tests across 7 files (47 unit + 17 integration). Unit tests run without
Postgres or Nuxt; the integration suite boots the fixture consumer at
`tests/fixtures/consumer/` via `@nuxt/test-utils/e2e` and exercises the live
`/mcp` route against a clean Postgres test database. See `tests/README.md`
for the full Phase L4 coverage list.

## OAuth-layer prerequisites

The MCP layer requires the OAuth layer to expose two helpers; both are already in place in this project's OAuth layer (commit landing alongside the MCP layer):

- `requireValidBearer(event)` — validates token + audience + family + client-enabled (no scope/RBAC). The MCP transport calls this at the boundary; per-tool scope and RBAC are enforced in the dispatcher.
- `__createAccessTokenForTest({ userId, clientId, scopes, ... })` — test-only helper that mints an `oauth_access_tokens` row directly, used by the layer's integration test harness. Production-guarded.
