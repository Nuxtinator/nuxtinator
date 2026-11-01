# OAuth 2.1 Layer

A Nuxt layer that adds an OAuth 2.1 authorization server to your app, suitable for issuing audience-bound access tokens to MCP clients (and any other OAuth client). All tokens are opaque random strings stored as SHA-256 hashes; scope strings are permissions from the consumer's RBAC vocabulary.

## What it provides

Routes:
- `GET /oauth/authorize` — start the authorization-code flow
- `POST /oauth/authorize` — consent submission
- `GET /oauth/consent` — server-rendered consent page. Permissions are grouped by app; the user unticks any they don't want the client to have. Unticked ones are saved as declined, so a client asking for the same set again skips the screen; it reappears only for a permission the user hasn't answered.
- `POST /oauth/token` — token endpoint (authorization_code, refresh_token grants)
- `POST /oauth/register` — Dynamic Client Registration (RFC 7591)
- `GET /.well-known/oauth-authorization-server` — RFC 8414
- `GET /.well-known/oauth-protected-resource` — RFC 9728

User-facing routes (require `requireAuth`):
- `GET /api/oauth/connected-apps` — list the current user's active grants
- `PATCH /api/oauth/connected-apps/:client_id` — change which of the permissions the app asked for it holds (`{ scopes }`). A removed one stops working on its live tokens at once; an added one arrives with its next refresh.
- `DELETE /api/oauth/connected-apps/:client_id` — revoke consent + cascade families

Admin routes (require `users.manage`):
- `GET /api/admin/oauth/clients` — paginated list with consent + family counts
- `PATCH /api/admin/oauth/clients/:client_id` — toggle `enabled`
- `GET /api/admin/oauth/families` — active token families with user/client joins
- `DELETE /api/admin/oauth/families/:family_id` — revoke a single family
- `GET /api/admin/oauth/events` — paginated `oauth.*` activity log

Pages (auto-discovered from the layer):
- `/admin/oauth` — single-page dashboard for clients/families/events. Uses `definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] })`. Consumer must define both.

Components (auto-imported):
- `<OauthConnectedApps />` — drop-in `UCard` for the user's profile page. Lists active grants, edits their permissions, revokes with confirmation. Self-contained.

App-layer routes accept this layer's access tokens with no extra code: the layer registers itself with core's bearer-auth registry, so `defineTenantHandler` / `withOrgContext` / `withOrgPermission` and the personal-app handlers sign a token request in as its user. A token only reaches routes gated on a permission it carries, `ctx.perms` holds only the permissions it was granted, `ctx.clientId` names the client, and the activity log records the client on everything the request logs. The org comes from `X-Active-Org`, else the user's only org.

Server utilities (auto-imported as Nitro server utils):
- `requireBearerScope(event, scope)` — guard an endpoint outside the standard handlers with a required scope
- `revokeFamily(familyId, reason)` — kill all tokens in a family
- `revokeConsentAndFamilies(userId, clientId, reason)` — wipe everything for one user × client
- `issueCode(...)` — internal use by routes; not typically called directly

## Hooks

The layer fires Nitro hooks at significant moments. Subscribe in a consumer-side server plugin:

| Hook | Payload | Fires when |
|---|---|---|
| `oauth:consent-granted` | `{ userId, clientId, clientName, dynamic, scope, resource, event }` | A user explicitly approves a new consent (auto-issue short-circuit does **not** fire this) |

The layer already ships a default subscriber for `oauth:consent-granted` (sends an anti-phishing email — see consumer requirement 7a). Subscribe to the same hook from the consumer if you want to add behavior **alongside** the default email (e.g. Slack notification, audit pipeline, ChatOps):

```ts
// server/plugins/20-oauth-notify-extra.ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('oauth:consent-granted', async (data) => {
    // your additional behavior
  })
})
```

To **replace** the default email (different copy, branding, i18n, transport), set `runtimeConfig.oauthDisableConsentGrantedEmail = true` and ship your own subscriber.

Hook subscriber failures must be swallowed by the subscriber — Nitro's hook runner re-raises errors and the OAuth grant flow should never block on email/notification failures.

Database:
- 7 tables (`oauth_clients`, `oauth_token_families`, `oauth_pending_requests`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`, `oauth_consents`) created via the layer's migration `oauth_001_create_oauth_tables.ts`.

Plugins:
- `oauth-config-validate.ts` — validates required config + runs preflight against the consumer's `users` table and `getUserPermissions` function.
- `oauth-cleanup.ts` — periodic sweeps of expired pending requests, codes, and tokens.

## Adding to a project

In your consumer project's `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  extends: ['../base-code/layers/oauth']
})
```

(Path relative to your consumer project root.)

### One-time setup: symlink node_modules

The migration runner imports the layer's migration file dynamically at runtime, which makes Node resolve `kysely` from the layer's path rather than the consumer's. For local dev with sibling-path layer extension, symlink the consumer's `node_modules` into the layer:

```bash
ln -s ../../<your-project>/node_modules /Users/jd/code/base-code/layers/oauth/node_modules
```

Run this once per consumer. The `node_modules` symlink is gitignored, so each consumer maintains its own. (Layers consumed via npm or `github:` resolve naturally inside `node_modules/.c12/…` and don't need this step.)

## Consumer requirements

This layer is **standalone** — it does not extend a base layer. It assumes your project conforms to the following shape:

### 1. `users` table

Must exist with `id` of type `uuid` as primary key. The OAuth tables foreign-key to `users.id`.

### 2. Auth utilities at `~~/server/utils/auth.ts`

Must export:
```ts
export function getAuthUser(event: H3Event): { userId: string } | null
export function requireAuth(event: H3Event): { userId: string }
```

`getAuthUser` returns null if not authenticated; `requireAuth` throws a 401 if not authenticated.

### 3. Permission readers from `#tenant/server`

The layer reads a user's permissions through the tenant kernel, never through `getUserPermissions` directly, so org memberships and per-user grants count in multi-tenant deploys:
```ts
export async function getUserPermissionsAcrossOrgs(userId: string): Promise<Set<Permission>>
export async function getUserPermissionsForRequest(event: H3Event, userId: string, opts?: { org?: string }): Promise<Set<Permission>>
```

Core's single-mode kernel provides both; the tenancy layer overrides them with org-aware versions. Consent and token issuance use the across-orgs union (tokens are not org-bound); `requireBearerScope` uses the per-request set for the org named by `X-Active-Org`.

### 4. Permission registry at `~~/app/utils/permissions.ts`

Must export:
```ts
export const PERMISSIONS: readonly string[]
export type Permission = typeof PERMISSIONS[number]
export const PERMISSION_META: Record<string, { title: string; description: string }>
export function isPermission(value: string): value is Permission
```

### 5. Database client at `~~/server/utils/database.ts`

Must export `db: Kysely<Database>`. The layer adds its tables to the `Database` interface via TypeScript module augmentation against `~~/server/database/schema`.

### 6. Schema interface at `~~/server/database/schema.ts`

Must declare `Database` as an `interface` (not a `type` alias). Module augmentation only extends interfaces.

### 7. Activity logger at `~~/server/utils/activity-logger.ts`

Must export:
```ts
export function logEvent(opts: { eventType: string; userId?: string; userAgent?: string; metadata?: Record<string, unknown> }): void
```

### 7a. Email transport at `~~/server/utils/email.ts`

Must export:
```ts
export async function sendEmail(opts: { to: string | string[]; subject: string; html: string; text?: string; from?: string }): Promise<boolean>
```

The layer ships a default `oauth:consent-granted` subscriber (`server/plugins/oauth-notify.ts`) that emails the user any time a new client is authorised on their account ("X was just connected to your account — if this wasn't you, revoke immediately"). It calls `sendEmail` directly with inline HTML/text — no template registry coupling — so consumers only need a working transport.

To opt out (e.g. ship your own subscriber with branded HTML or i18n copy), set `runtimeConfig.oauthDisableConsentGrantedEmail = true` in your consumer's `nuxt.config.ts`.

### 7b. Admin layout + middleware (only if you mount `/admin/oauth`)

The shipped `app/pages/admin/oauth.vue` declares `definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] })`. Your consumer must define both:
- `app/layouts/admin.vue` — the admin chrome (sidebar, etc.).
- `app/middleware/auth.ts` and `app/middleware/admin.ts` — gate non-authenticated and non-admin users.
- A sidebar entry pointing to `/admin/oauth`, conditional on `hasPermission('users.manage')`.

### 8. Rate limiter at `~~/server/utils/rate-limit.ts`

Must export:
```ts
export function checkRateLimit(key: string, scope: string, identifier: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
export function logRateLimitExceeded(ip: string, route: string, userAgent?: string): void
```

### 9. Migration runner that walks layers

The consumer's migration runner must read migration files from `nuxt.options._layers` (each layer's `migrations/` folder), not just from `<cwd>/migrations`. See "Migration runner upgrade" below.

## Environment variables

Required:

```
OAUTH_CONSENT_COOKIE_SECRET=<openssl rand -base64 32>
OAUTH_ALLOW_DCR=true
NUXT_PUBLIC_SITE_URL=https://your-app.example.com
```

`NUXT_PUBLIC_SITE_URL` is also used as the OAuth `iss` (issuer) value. The MCP resource URI is computed as `${NUXT_PUBLIC_SITE_URL}/mcp`.

## Optional config overrides

In your consumer's `nuxt.config.ts`:

```ts
runtimeConfig: {
  oauth: {
    loginPath: '/sign-in'   // default '/login'
  }
}
```

## MCP endpoint

This layer ships the OAuth authorization server only. The MCP endpoint at `/mcp` is your responsibility — mount it as a Nitro server route in the consumer:

```ts
// server/routes/mcp.ts
export default defineEventHandler(async (event) => {
  const auth = await requireBearerScope(event, 'pages.read')
  // ... handle MCP request, auth.userId is the user, auth.scopes is granted
})
```

## Migration runner upgrade

The layer ships its migration in `<layer>/migrations/oauth_001_create_oauth_tables.ts`. For your migration runner to pick it up, you need a layer-aware setup. Add a Nuxt module:

```ts
// modules/migrations.ts
import { defineNuxtModule } from '@nuxt/kit'
import path from 'path'
import { existsSync } from 'fs'

export default defineNuxtModule({
  setup(_, nuxt) {
    nuxt.options.runtimeConfig.layerMigrationPaths = nuxt.options._layers
      .map(l => path.join(l.cwd, 'migrations'))
      .filter(p => existsSync(p))
  }
})
```

Reference it in `nuxt.config.ts`:

```ts
modules: ['./modules/migrations']
```

Update your `server/plugins/migrations.ts` to read from `runtimeConfig.layerMigrationPaths` and feed all paths to the migration provider.

## Naming convention for layer migrations

Layers prefix migration filenames with the layer name (`oauth_001_*`, `<nextlayer>_001_*`). Filenames are sorted globally → stable execution order across all layers and the consumer's own numeric-prefixed migrations.
