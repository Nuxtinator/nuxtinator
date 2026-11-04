# Tenancy (optional layer)

Tenancy in go-saas is an **optional layer** ([layers/tenancy/](../layers/tenancy/)). When it's in `extends:`, the deploy is multi-tenant: each **organization** (`orgs` table) is a tenant with its own members, role overrides, app-enable state, and data — sharing a global app catalog and global user identity. When it's omitted, the deploy is single-tenant — see [single-tenant-deploy.md](single-tenant-deploy.md).

This document covers the **multi-tenant** operator setup. Layer-author guidance lives in [layers.md](layers.md). Architectural reasoning lives in [/Users/jd/code/go-saas/context/plans/multi-tenancy-layer/](/Users/jd/code/go-saas/context/plans/multi-tenancy-layer/).

---

## Database role setup (one-time, manual)

Tenant isolation is enforced via **Postgres Row-Level Security**, with the same two roles every deploy uses — see [database-roles.md](database-roles.md) for the SQL. Multi-tenant deploys add one thing: the owner role (`host_admin`) must have `BYPASSRLS`, since the tenancy layer's cross-org `/api/admin/orgs/*` endpoints use it through `adminDb`.

| Role | Purpose | RLS |
|---|---|---|
| `host_admin` | Migrations + cross-org `/api/admin/orgs/*` endpoints | `BYPASSRLS` |
| `app_user` | Default for all request handlers and layer code | RLS-enforced |

Verify:

- `\du host_admin` shows `BYPASSRLS`
- `\du app_user` does NOT show `BYPASSRLS`
- After migrations run, `\dp orgs` shows `arwd` privileges granted to `app_user`

---

## Environment variables

Two connection strings — same database, different roles:

```bash
DATABASE_URL=postgres://host_admin:...@localhost/<dbname>    # migrations + tenancy layer's adminDb
APP_DATABASE_URL=postgres://app_user:...@localhost/<dbname>  # default for the host's `db`
NUXT_TENANT_FLOW_SECRET=<random 32+ bytes hex>        # HMAC key for OAuth state-binding
```

`db`'s role must be one RLS applies to: if it is a superuser, has `BYPASSRLS`, or owns an RLS table, every request is refused with a 503 and the reason is logged as `[core] Row-level security is not enforced…` ([rls-guard.ts](../layers/core/server/utils/rls-guard.ts)). Set both variables, in dev too.

`NUXT_TENANT_FLOW_SECRET` is consumed by `encodeFlowOrg`/`decodeFlowOrg` (see [layers/tenancy/server/utils/tenant.ts](../layers/tenancy/server/utils/tenant.ts)). Used by OAuth flows to bind the active org to the `state` parameter — without this, an OAuth flow started in org A and completed after a tab switch could land tokens in org B.

---

## Connection pool requirements

If running through PgBouncer (or any pooler):

1. **Transaction-pooling mode is required.** `defineTenantHandler` uses `SET LOCAL`, which is transaction-scoped. Session-pooling would leak `app.current_org` across requests.
2. **`prepare: false` on the postgres-js driver.** PgBouncer txn-pooling disallows server-side prepared statements. Both [host's `db`](../layers/core/server/utils/database.ts) and the tenancy layer's [adminDb](../layers/tenancy/server/utils/database-admin.ts) ship with this configured.

Direct connections (no pooler) work too; `prepare: false` is a small perf hit but kept on so behavior matches production.

---

## RLS policy — missing-safe

Every tenant-scoped table has:

```sql
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON x FOR ALL
  USING       (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK  (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
```

The `, true` in `current_setting` returns `NULL` (instead of raising) when the GUC is unset. The predicate then evaluates `org_id = NULL` → **FALSE → 0 rows**. A handler that forgets `defineTenantHandler` returns "no data", not a leak.

The column DEFAULT is `current_org_id()`:

```sql
CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_org', true), '')::uuid $$;
```

So INSERTs that omit `org_id` get auto-stamped from the GUC inside `defineTenantHandler`'s transaction. Outside an org context the function returns NULL → fail-loud (NOT NULL constraint blocks the insert), never wrong-org.

Layer migrations use the `enableTenantScoping(db, table)` helper from `#tenant/server` to set up the column + policy + RLS in one call.

---

## Visiting several orgs

A transaction sees exactly one org. Work that covers several orgs visits each in turn, with that org's GUC set, using helpers from `#tenant/server`:

- `listUserOrgs(userId, { permission?, appId?, orgIds? })` — the user's orgs (suspended excluded) with their effective permission set in each, narrowed by permission, enabled app or an explicit selection. Reads no tenant data.
- `listOrgScopes({ activeOnly?, appId? })` — the org ids a session-less job visits: active ones only, and only where the app is on. Single mode returns `[null]`.
- `withOrgScope(orgId, fn)` — a transaction scoped to one org (`null`: a plain transaction in single mode).

```ts
for (const orgId of await listOrgScopes({ activeOnly: true, appId: 'inbox' })) {
  await withOrgScope(orgId, tx => sweep(tx))
}
```

---

## URL shape

Multi-mode page URLs use an `@`-prefix for the org slug:

```
/@acme/calendar/events            ← org-scoped page (tenancy pages:extend alias)
/@acme/settings/members           ← tenancy layer's own page
/api/calendar/events              ← API; org context via X-Active-Org header
/api/admin/orgs/<id>/members      ← cross-org host admin endpoint
/admin/users                      ← global host admin
/account                          ← user-global
```

The `@` prefix is the disambiguator: no slug can collide with any system top-level path. Slug shape is `^[a-z0-9-]{2,40}$`. No reserved-name list.

### Route guard + opt-out

[tenant-route-guard.global.ts](../layers/tenancy/app/middleware/tenant-route-guard.global.ts) rewrites naive in-app links (`/calendar`) to the active org (`/@acme/calendar`), and sends bare app paths with no active org to `/orgs`. Routes that must pass through untouched are exempted two ways:

- **`definePageMeta({ tenantExempt: true })`** on the page — the per-page, per-layer escape hatch. A layer exempts its own public route (e.g. the feedback widget's `/feedback/connect` sign-in bridge) without editing the guard. The flag is typed in [tenancy/types.d.ts](../layers/tenancy/types.d.ts).
- **`SYSTEM_PREFIXES`** in the guard — a central list for whole subtrees (`/admin`, `/account`, …) that can't be tagged page-by-page.

---

## OAuth + multi-tenancy

The OAuth layer's `oauth_consents` and `oauth_pending_requests` tables are org-scoped via the per-app tenancy migration [layers/oauth/migrations/oauth_T010_enable_tenancy.ts](../layers/oauth/migrations/oauth_T010_enable_tenancy.ts). Token tables (`oauth_token_families`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`) stay user-scoped — they represent the user's identity to a third party.

OAuth flows that need org binding use `encodeFlowOrg(state, slug)` / `decodeFlowOrg(state)` from `#tenant/server`. The encoded state survives third-party redirects and tab switches.

---

## Bootstrap operator admin

After migrations have run, create or promote a user with `is_admin=true`:

```bash
bun run scripts/bootstrap-admin.ts
```

The script prompts for email + display name + password, creates the row (or promotes an existing user), and is idempotent. Operator admin gates `/api/admin/*` endpoints in both single and multi modes; in multi mode it's also the only role that can use the BYPASSRLS `adminDb` for cross-org operations.

---

## Hooks

The tenancy layer emits Nitro hooks layers can subscribe to. Only fire in multi mode (single-mode subscribers are harmless no-ops).

| Event | Payload |
|---|---|
| `org.created` | `{ orgId, slug, createdByUserId }` |
| `org.deleted` | `{ orgId, slug }` |
| `membership.created` | `{ membershipId, userId, orgId, roles, createdByUserId }` |
| `membership.updated` | `{ membershipId, userId, orgId, oldRoles, newRoles }` |
| `membership.deleted` | `{ membershipId, userId, orgId }` |
| `app.enabled` | `{ orgId, appId }` |
| `app.disabled` | `{ orgId, appId }` |

Hooks `user.created` and `user.verified` fire in both modes (they don't depend on tenancy).
