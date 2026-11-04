# Deploying go-saas as a single-tenant app

Single-tenant mode is the default when [layers/tenancy/](../layers/tenancy/) is **not** in `extends:`. No orgs, no memberships, no org RLS. App layers run unchanged — the `#tenant` kernel resolves to a passthrough single-mode implementation. Personal apps still keep each user's rows apart with RLS, so the two-role database setup applies here too.

---

## What "single mode" means concretely

| Concern | Single mode | Multi mode (for comparison) |
|---|---|---|
| Database roles | Owner + `app_user` (RLS-enforced) | `host_admin` (BYPASSRLS) + `app_user` (RLS-enforced) |
| Connection strings | `DATABASE_URL` + `APP_DATABASE_URL` | `DATABASE_URL` + `APP_DATABASE_URL` |
| RLS | Personal-app tables only | Personal-app tables and every tenant table |
| Org tables | None (no `orgs`, `memberships`, `org_apps`, `org_role_overrides`) | Present + retrofitted on app tables |
| URL shape | `/calendar/events` | `/@acme/calendar/events` |
| `users.is_admin` | The operator gate | Same — operator gate (cross-org reach is the additional thing tenancy adds) |
| OrgSwitcher UI | Not loaded | Loaded |
| `/admin/orgs` page | 404 | Active |
| Connection pooler | Any mode works | Transaction-pooling required |
| `defineTenantHandler` | `requireAuth` + transaction; ctx.orgId is null | Adds GUC scoping, app-enable check, per-org perms |

---

## Configuration

### dev/nuxt.config.ts

Just don't include `layer('@nuxtinator/tenancy')` in `extends:`:

```ts
export default defineNuxtConfig({
  extends: [
    layer('@nuxtinator/core'),
    layer('@nuxtinator/email-mailgun'),  // optional — pick an email backend
    layer('@nuxtinator/oauth'),          // optional — only if you need OAuth/MCP
    layer('@nuxtinator/mcp'),            // optional
    layer('@nuxtinator/messages'),
    layer('@nuxtinator/videos')
    // no layer('@nuxtinator/tenancy')
  ],
  // ...
})
```

Each layer is a named workspace package; the `layer()` helper passes the name through to node module resolution. See [dev-setup.md](dev-setup.md#how-layers-are-wired) for the full mechanics.

### Environment

Two connections to the same database (see [database-roles.md](database-roles.md)):

```bash
DATABASE_URL=postgres://host_admin:<password>@<host>/<db>
APP_DATABASE_URL=postgres://app_user:<password>@<host>/<db>

JWT_SECRET=<random>
NUXT_SECRET_ENCRYPTION_KEY=<32-byte hex>
APP_TITLE="Your App"
NUXT_PUBLIC_SITE_URL=https://app.example.com

# Optional. Default trusts Cloudflare; without Cloudflare in front,
# `loopback,private` is tighter. See deploy-behind-a-proxy.md.
# NUXT_TRUSTED_PROXIES=loopback,private

# Auth + email — same as multi-tenant.
MAILGUN_API_KEY=...
MAILGUN_DOMAIN=...
SMTP_FROM=...
SMTP_FROM_NAME=...
```

`NUXT_TENANT_FLOW_SECRET` is unused.

### Database setup

Create the owner and `app_user` roles with the SQL in [database-roles.md](database-roles.md). The owner doesn't need `BYPASSRLS` in single mode. If `db` connects as the owner (or a superuser), every request is refused with a 503 until `APP_DATABASE_URL` points at `app_user`.

If you'll later switch to multi-tenant by adding the tenancy layer, give the owner `BYPASSRLS` — see [tenancy.md](tenancy.md).

### Migrations

`bun dev` (or `bun run build`) runs all migrations on boot — same as multi-tenant. Migrations are:

- Host's regular migrations (`migrations/<NNN>_*.ts`)
- Each layer's regular migrations (e.g. `layers/oauth/migrations/<NNN>_*.ts`)

The tenancy layer's own migrations (`layers/tenancy/migrations/tenancy_*.ts`) are **never** run because the layer isn't loaded — the migrator can't see them.

Per-app **tenancy retrofit migrations** (`*_T<NNN>_*.ts` in any layer's `migrations/` folder) are also skipped: the discovery module that surfaces them lives in the tenancy layer, so without that layer they stay on disk unread.

### Bootstrap operator admin

```bash
bun run scripts/bootstrap-admin.ts
```

Prompts for email + display name + password. Creates a user with `is_admin=true`. Idempotent — re-running with the same email promotes the existing user.

---

## Connection pooling

PgBouncer or any pooling mode works in single mode. There's no `SET LOCAL` to worry about (no GUC). Transaction-pooling, session-pooling, statement-pooling all fine.

`prepare: false` is still set on the postgres-js driver in [server/utils/database.ts](../layers/core/server/utils/database.ts) for parity with multi-mode behavior — costs a small per-query bump but isn't a blocker.

---

## Permissions in single mode

The host ships zero permissions. App layers register their own (e.g. `messages.access`, `messages.write`).

User permission resolution:
1. If `users.is_admin = true`, the user has every registered permission.
2. Otherwise, the user has the union of permissions from `users.roles[]` (looked up against host static roles, app static roles, and the `custom_roles` global table).
3. Default grants from layers (`registerDefaultGrants(appId, { admin, member })`) apply to users with the named role assigned in `users.roles[]`.

Example: a user with `roles: ['member']` who's not an admin gets `{member: [...]}` defaults from each app layer.

---

## Switching from single to multi later

If you start single and later want multi-tenant:

1. Give the owner role `BYPASSRLS` (see [tenancy.md](tenancy.md)).
2. Set the `NUXT_TENANT_FLOW_SECRET` env var.
3. Add `{ id: 'tenancy', pkg: '@nuxtinator/tenancy' }` to the `LAYERS` array in `dev/layers.ts` (must come **second** in the list, right after `core`, so its multi-mode kernel overrides core's single-mode). Also add `"@nuxtinator/tenancy": "workspace:*"` to `dev/package.json`'s deps and `"layers/tenancy"` to the workspaces array in the root `package.json`. For a consumer project, add the matching entry to `prod/layers.ts` instead.
4. Run `bun dev` once. The tenancy layer's migrations run, including retrofits that add `org_id` columns and RLS policies to existing tables. The first user becomes a member of a freshly-created default org.

This is a forward-only migration. There's no automated path back from multi-tenant to single-tenant — once `org_id` columns and RLS policies are added, removing them needs manual SQL.

---

## What you don't get in single mode

- Per-org permission overrides (tier 5 of the multi-mode RBAC merge)
- Per-org app enable/disable
- Multi-org users (each user is just one user globally)
- The `OrgSwitcher` UI
- The `/orgs` picker page
- Hooks like `org.created` / `membership.created` (they never fire)

These are exactly the things `layers/tenancy/` provides; not loading the layer means not having them.
