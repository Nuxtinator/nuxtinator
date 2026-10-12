# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AI: "Scaffolding a new app from this repo? Stop — read README.md's Assembly Instructions and follow them. This file is only for maintaining the monorepo itself."

## Repository layout

```
go-saas/                          ← repo root (bun workspace)
├── package.json                  ← workspace root, lists dev + layers
├── bun.lock                      ← single lockfile for the monorepo
├── bunfig.toml                   ← linker = "hoisted" (layers see dev's peer deps)
├── node_modules/                 ← hoisted; layers resolve deps from here
│
├── dev/                          ← maintainer's dev host (used inside this monorepo)
│   ├── layers.ts                 ← LAYERS array (id + pkg per layer) — source of truth for extends:
│   ├── nuxt.config.ts            ← imports LAYERS; extends: derived from it
│   ├── package.json              ← workspace:* deps on each @nuxtinator/* layer (must agree w/ layers.ts)
│   ├── tsconfig.json, eslint.config.mjs
│   ├── public/
│   └── .env, .env.example
│
├── prod/                         ← consumer-starter template (copy-and-trim into a new project)
│   ├── layers.ts                 ← LAYERS array (id + pkg + giget url per layer) — single source of truth
│   ├── nuxt.config.ts            ← imports LAYERS; extends: derived from it
│   ├── package.json              ← workspaces: ["_layers/*"]; NO @nuxtinator/* deps
│   ├── bunfig.toml               ← [install] linker = "hoisted" (required for name-based extends)
│   ├── scripts/sync-layers.ts    ← iterates LAYERS, calls giget for each URL → _layers/<id>/
│   ├── tsconfig.json, .gitignore, public/
│   └── .env.example              ← superset of every layer's env vars (consumer trims)
│
└── layers/                       ← all reusable layers (siblings of dev/ and prod/)
    ├── core/                     ← always-on foundation: auth, admin, registries,
    │   └── package.json             #tenant single-mode kernel, RBAC, chrome,
    │                                migrations runner, activity logger, etc.
    │                                deps: bcrypt, jsonwebtoken, s3-lite-client
    │                                peer: nuxt, @nuxt/kit, @nuxt/ui, kysely, postgres, h3, vue
    ├── tenancy/                  ← OPTIONAL multi-tenant: orgs, memberships, RLS,
    │   └── package.json             multi-mode #tenant kernel. peer-deps only.
    ├── email-mailgun/            ← OPTIONAL email backend (provides #email).
    │   └── package.json             deps: nodemailer, nodemailer-mailgun-transport
    ├── oauth/                    ← OPTIONAL OAuth 2.1 server (peer-deps only)
    ├── mcp/                      ← OPTIONAL MCP transport
    │   └── package.json             deps: @modelcontextprotocol/sdk, zod, zod-to-json-schema
    ├── dev/                      ← OPTIONAL UI sandbox layer (@nuxtinator/dev — distinct
    │                                from the top-level dev/ host folder above). /kitchen pages.
    └── apps/                     ← per-app feature layers
        ├── calendar/             ← peer-deps only
        ├── kanban/               ← peer-deps only
        ├── messages/             ← deps: dompurify, marked, emoji-mart, croner
        └── videos/               ← deps: fix-webm-duration, mediabunny, uuid
```

### `dev/` vs `prod/` — two hosts, two recipes

Both are Nuxt host shells; they differ in **how they resolve layers**:

- **`dev/`** is a workspace member of this monorepo. Layer selection lives in [dev/layers.ts](dev/layers.ts) — a `LAYERS` array of `{ id, pkg }` entries — and `dev/nuxt.config.ts` derives `extends:` from it. `dev/package.json` separately lists each layer as `"@nuxtinator/<id>": "workspace:*"` so bun symlinks each name into `dev/node_modules/@nuxtinator/<id>/` (the two files must agree — bun needs the explicit dep entry to symlink). Use this for editing layers + host together. Run `bun dev` from `dev/`.
- **`prod/`** is a **standalone starter template** — NOT a workspace member of this monorepo. It uses the consumer recipe: `workspaces: ["_layers/*"]`, a `sync-layers` script that fetches each chosen layer from a giget URL into `_layers/<id>/`, `bunfig.toml linker = "hoisted"` for name-based resolution. When someone starts a new project on nuxtinator, they copy `prod/` (via `bunx giget github:corsacca/nuxtinator/prod#master . --force` — the `#master` ref is required because giget defaults to `main` but this repo's default branch is `master`), trim it to their selected layers, and run `bun run setup`. `prod/` is what the README's Assembly Instructions point to.

Two `dev` names exist (the top-level `dev/` host folder and the `layers/dev/` `@nuxtinator/dev` sandbox layer) and they're distinct things. Context (path vs. package name) disambiguates.

Every layer has its own `package.json` declaring exactly what it imports. The `name` is `@nuxtinator/<id>` and the package exposes its config via `exports: { ".": "./nuxt.config.ts" }`. Cross-layer deps are declared as `"*"` in `optionalDependencies` (e.g. `"@nuxtinator/core": "*"`) — not `workspace:*`, which resolves only inside this monorepo and breaks a consumer's standalone install. Layer-private deps (no other layer needs them, no shared runtime state) go in `dependencies`. Framework/DB singletons that must resolve to a single instance (`nuxt`, `@nuxt/kit`, `@nuxt/ui`, `kysely`, `kysely-postgres-js`, `postgres`, `h3`, `vue`, `tailwindcss`) go in `peerDependencies` so they resolve to host's installed copy. Don't add a `main` field to layer package.json files — Nuxt generates `/// <reference types="@nuxtinator/<id>" />` and TS would resolve through `main`, breaking the typecheck. `exports` is fine.

Run dev/build from `dev/`:

```
cd dev
bun dev          # start dev server (runs migrations on boot via Nitro plugin)
bun run build    # production build
bun run preview  # preview built app
bun run lint     # eslint
bun run typecheck  # vue-tsc / nuxt typecheck
```

Dev server defaults to port **2080**.

### Layer source resolution

[dev/layers.ts](dev/layers.ts) holds a `LAYERS` array (one `{ id, pkg }` entry per layer); [dev/nuxt.config.ts](dev/nuxt.config.ts) imports it and derives `extends: LAYERS.map(l => layer(l.pkg))`. A tiny `layer()` helper lets a single layer be redirected to a local checkout via an env var; otherwise the package name is passed through and Nuxt resolves it via standard node module resolution against `node_modules/`:

```ts
function layer(pkg: string): string {
  // @nuxtinator/messages → NUXTINATOR_MESSAGES_PATH
  const envKey = pkg.replace(/^@/, '').replace(/[/-]/g, '_').toUpperCase() + '_PATH'
  return process.env[envKey] || pkg
}
```

Layers can arrive in `node_modules/@nuxtinator/<id>/` from three sources, same path on disk, same `extends:` line:

- **Workspace symlink** in this repo (`"@nuxtinator/core": "workspace:*"` in `dev/package.json`).
- **npm tarball** once published.
- **Git URL** in a downstream project's `package.json` deps (`"github:org/repo#ref"`) when a layer lives in its own repo.

Cross-layer name resolution works automatically because each layer's `package.json` declares its own deps — when `@nuxtinator/messages` imports from `@nuxtinator/core`, node module resolution walks up from the messages package and finds core wherever bun/npm/git put it.

**Per-layer local override.** Two ways to point a single layer at a sibling checkout without changing committed config:

- **Env var** — set `NUXTINATOR_<ID>_PATH` in `dev/.env` (id uppercased, hyphens become underscores), e.g. `NUXTINATOR_MESSAGES_PATH=../../scratch/messages-experiment`. The `layer()` helper reads it and returns the path instead of the package name.
- **`bun link`** — run `bun link` in a sibling repo, then `bun link @nuxtinator/messages` in this one. Symlinks the sibling into `node_modules/@nuxtinator/messages/` until the next `bun install`.

## High-level architecture

This repo is **a host shell + a stack of layers** wired through Nuxt's `extends:`. The host (`dev/`) is project-specific (config, branding, page overrides). All reusable code lives in `layers/`. New projects copy the layers they need and write their own thin host.

### Layer roles

| Layer | Role | Always on? |
|---|---|---|
| `core` | Auth, admin, profile pages; 6 runtime registries; #tenant single-mode kernel; RBAC; activity logger; rate limiter; secret crypto; storage; slug; migrations runner; bootstrap-admin script; launcher chrome (AppRail, AppSidebar, layouts, composables). | yes |
| `tenancy` | Multi-tenant: orgs, memberships, org_apps, org_role_overrides, RLS, BYPASSRLS adminDb, OrgSwitcher, /admin/orgs UI, multi-mode #tenant kernel that overrides core's. | optional |
| `email-mailgun` | Mailgun (HTTP API in prod, MailHog locally). Provides `#email` alias. | optional* |
| `email-smtp` | (planned) Plain SMTP via nodemailer. | optional* |
| `email-ses` | (planned) AWS SES. | optional* |
| `oauth` | OAuth 2.1 issuer (token, consent, admin endpoints). | optional |
| `mcp` | MCP server transport (depends on oauth). | optional |
| `dev` | UI sandboxes (e.g. `/kitchen`). | optional |
| `apps/<id>` | Per-app feature: pages + routes + perms + migrations. | per-project choice |

*If no email layer is loaded, code that imports from `#email` throws helpfully at first call.

### Layer auto-discovery escape

Nuxt 4 auto-discovers any direct child of `dev/layers/*` (regardless of `extends:`). To keep `tenancy` truly optional, all layers live at `<repo>/layers/` (siblings of `dev/`, not under `dev/layers/`), so the auto-glob doesn't see them. Each layer is loaded only via an explicit `layer('<name>')` entry in `extends:`. Comment out a line to remove that layer. Adding a layer also requires adding `"layers/<name>"` (or `"layers/apps/<name>"`) to the `workspaces` array in the root `package.json`.

### The `#tenant` kernel

App layers and host code import tenancy helpers from two aliases:

- `#tenant` — client composables (`useActiveOrg`, `useMaybeActiveOrg`, `getActiveSlug`, `useTenantFetch`)
- `#tenant/server` — server helpers (`defineTenantHandler`, `withOrgContext`, `requireOperatorAdmin`, `runInOrgTransaction`, `encodeFlowOrg`/`decodeFlowOrg`)

Two implementations swap based on whether the tenancy layer is loaded:

- **Single mode** (default, in [layers/core/tenant-kernel/{client,server}.ts](layers/core/tenant-kernel/)). Registered by [layers/core/modules/tenant-kernel.ts](layers/core/modules/tenant-kernel.ts) only if no other module set the alias. `defineTenantHandler` does `requireAuth` + transaction; no GUC, no app-enable check. `useActiveOrg().slug.value` is always `null`.
- **Multi mode** (provided by `layers/tenancy/`, in `layers/tenancy/{app,server}/utils/tenant.ts`). Registered first by `layers/tenancy/modules/tenant-kernel.ts` (unconditionally); the host fallback yields. `defineTenantHandler` reads org from `event.context.orgSlug` (set by tenancy Nitro middleware), opens a transaction, runs `SET LOCAL app.current_org` inside it, runs the handler. The GUC is **only** set inside the handler's transaction.

### The `#core` alias

Cross-layer imports of core utilities use `#core/...` (resolved by [layers/core/nuxt.config.ts](layers/core/nuxt.config.ts)) so paths don't depend on whether the importing layer sits next to or under the host:

```ts
import { db } from '#core/server/utils/database'
import { requireAuth } from '#core/server/utils/auth'
import { PERMISSION_META } from '#core/app/utils/permissions'
```

### The `#email` alias

Auth/notification code imports email helpers from `#email`:

```ts
import { sendTemplateEmail } from '#email'
```

Each email backend layer (`email-mailgun`, future `email-smtp`/`email-ses`) provides its own implementation and registers `#email` to point at it. Core ships a throwing fallback at [layers/core/email-fallback/email.ts](layers/core/email-fallback/email.ts) that surfaces a clear error if no email layer is loaded.

### Translations (i18n)

Core loads `@nuxtjs/i18n` once ([layers/core/nuxt.config.ts](layers/core/nuxt.config.ts)): `no_prefix` strategy (URLs never change, so tenancy's `/@:orgSlug` aliases aren't multiplied), default locale `en`, browser detection with the choice remembered in the `i18n_locale` cookie. Missing keys fall back to English without console warnings ([layers/core/i18n/i18n.config.ts](layers/core/i18n/i18n.config.ts)), so a layer may translate only part of its strings. Nuxt UI's own strings and `<html lang/dir>` follow the active locale ([layers/core/app/app.vue](layers/core/app/app.vue)).

Translation is opt-in per layer. A layer that wants it:

1. Declares its locales in its own `nuxt.config.ts` (no `modules:` entry needed):
   ```ts
   i18n: {
     locales: [
       { code: 'en', file: 'en.json' },
       { code: 'fr', language: 'fr', name: 'Français', file: 'fr.json' }
     ]
   }
   ```
2. Ships the files at `<layer>/i18n/locales/<file>`, with every key under the layer id (`{ "people-groups": { "fields": { "bible_status": "…" } } }`).
3. Uses `$t('<layerId>.…')` / `useI18n()` in its components, and places `<LocaleSwitcher />` (core) wherever it wants the picker. The switcher hides itself when only one locale exists.

The module merges locales and messages across all layers by locale code; the host's files win over a layer's. The picker lists the union of every layer's locales. Worked example: [layers/dev/i18n/](layers/dev/i18n/) + `/kitchen-i18n`. Core's own UI, the server-registered labels (apps/nav/admin-section titles), and emails are not translated.

### Layer wiring (dev/nuxt.config.ts)

[dev/nuxt.config.ts](dev/nuxt.config.ts) does three layer-related things worth knowing about:

1. **`stripLayerTsconfigs()`** runs before modules — layers extracted from full Nuxt projects sometimes ship a `tsconfig.json` that references `./.nuxt/tsconfig.*.json` (only generated when the layer is opened standalone). Vite's tsconfig walker would crash; the cleanup deletes them.
2. **`extends:`** lists every layer in load order. `core` first (lowest priority — gets overridden by other layers and host); `tenancy` next (multi-mode kernel overrides core's single-mode); then email backend, oauth, mcp, app layers, dev.
3. **The host has no modules of its own** — `migrations`, `tenant-kernel`, and `email-kernel` modules all live in `layers/core/nuxt.config.ts`.

### The six runtime registries (core owns)

Every app layer feeds the host through six in-process registries in [layers/core/server/utils/](layers/core/server/utils/) at boot via a Nitro plugin:

| Registry | File | Function |
|---|---|---|
| Permissions (runtime) | [permissions-registry.ts](layers/core/server/utils/permissions-registry.ts) | `registerPermissions(perms, meta?)` |
| Default grants | [default-grants-registry.ts](layers/core/server/utils/default-grants-registry.ts) | `registerDefaultGrants(appId, { admin, member })` |
| App static roles | [roles-registry.ts](layers/core/server/utils/roles-registry.ts) | `registerStaticRole(...)` |
| Launcher tiles | [app-registry.ts](layers/core/server/utils/app-registry.ts) | `registerApp(...)` |
| In-app nav items | [nav-registry.ts](layers/core/server/utils/nav-registry.ts) | `registerNavItem(...)` |
| Admin shell sections | [admin-section-registry.ts](layers/core/server/utils/admin-section-registry.ts) | `registerAdminSection(...)` |

The host bridges these to the client via auth-gated, permission-filtered endpoints (`/api/_apps`, `/api/_nav`, `/api/_admin-sections`) consumed by composables (`useApps`, `useAppNav`, `useAdminSections`). Core's own admin sections are registered the same way — see [layers/core/server/plugins/register-host-admin.ts](layers/core/server/plugins/register-host-admin.ts).

### Permissions: compile-time + runtime

Two parallel permission stores you must keep in sync:

- **Compile-time** — the open `PermissionRegistry` interface in [layers/core/app/utils/permissions.ts](layers/core/app/utils/permissions.ts). Each app layer adds keys via `declare module '#permissions'` so `Permission` widens automatically.
- **Runtime** — the `_layerPerms` Set in [layers/core/server/utils/permissions-registry.ts](layers/core/server/utils/permissions-registry.ts), populated when each layer's Nitro plugin calls `registerPermissions(...)`.

Core itself ships **no** permissions — operator-admin authority is the `users.is_admin` boolean (no permission slug), checked via `requireOperatorAdmin(event)` from [layers/core/tenant-kernel/server.ts](layers/core/tenant-kernel/server.ts). The tenancy layer adds `org.*` permissions when loaded.

Code that checks permissions calls `isRegisteredPermission()` / `getAllPermissions()` — it never reads the static `PERMISSIONS` array directly, so layer contributions are always included. The `admin` role name is special-cased in [rbac.ts](layers/core/server/utils/rbac.ts) `getRolePermissions` to union every registered permission.

Use granular permissions (e.g. `mail.read`, `mail.write`) not coarse ones (`mail.manage`) — the same vocabulary is shared with OAuth scopes.

### Settings pattern: `defineSettings`

Every setting that combines code-declared defaults with DB-stored overrides goes through [layers/core/server/utils/settings.ts](layers/core/server/utils/settings.ts) → `defineSettings({...})`. Don't hand-roll the merge — one pattern, one read shape, one fallback rule across the whole app. Inspired by Disciple.Tools' `get_post_field_settings` (registry/template defaults → `apply_filters` → DB customizations → merged result).

The merge is always registry-first: code is the source of truth for *what exists*, the DB is the source of truth for *what was overridden*. An entry that exists in code but has no DB row still appears (with declared defaults). An entry that exists in the DB but not in code is an orphan — surfaced only if the caller opts in via `includeOrphans` (host-admin pages do; per-org filters don't).

A spec has five fields:

```ts
defineSettings<TDefault, TOverride, TResult>({
  loadDefaults: (tx, ctx) => TDefault[]            // usually wraps a registry
  loadOverrides: (tx, ctx) => Map<string, TOverride>  // DB read keyed by id
  keyOf: (d: TDefault) => string                   // join key — `id` for apps, `key` for roles
  merge: (default, override) => TResult            // both optional; called once per default + once per orphan
  includeOrphans?: boolean                         // default false
})
```

Returns `(tx, ctx?) => Promise<TResult[]>`. Compose for multi-tier merges (catalog overlay + per-org overlay): `loadDefaults` of the outer spec calls the inner reader. See [layers/tenancy/server/utils/app-settings.ts](layers/tenancy/server/utils/app-settings.ts) for the canonical example — `getOrgApps` stacks on top of `getApps`.

Live examples:
- Apps catalog (host view): [layers/core/server/utils/app-settings.ts](layers/core/server/utils/app-settings.ts) — `getApps`
- Apps catalog (per-org view): [layers/tenancy/server/utils/app-settings.ts](layers/tenancy/server/utils/app-settings.ts) — `getOrgApps`

When adding a new settings surface (e.g. custom roles, per-org branding, host-level feature flags): write a `<thing>-settings.ts` file with one `defineSettings` call, export the reader, and have endpoints call it. Don't put the DB read in the endpoint; don't do the merge inline.

### App-layer page paths — write single-tenant shape

App layer pages live at `app/pages/<appId>/...` and routes mount at `server/routes/api/<appId>/...`. App authors do **not** prefix paths with `/@:orgSlug/...`.

In multi-tenant mode the tenancy layer's [pages:extend](layers/tenancy/modules/tenant-pages-extend.ts) Nuxt build hook adds parallel `/@:orgSlug/<path>` route aliases pointing at the same Vue components. The router guard preserves the `@<slug>/` prefix on internal navigation. APIs always live at `/api/<app>/...`; org context travels in an `X-Active-Org` header the layer's fetch interceptor injects.

Tenancy layer's own org-aware admin endpoints live at `/api/o/<slug>/...` (the `o/` prefix is mechanical — Nitro's filesystem router doesn't reliably resolve `@` literals in path segments the way Vue Router does for pages).

### Tenancy layer (optional)

When [layers/tenancy/](layers/tenancy/) is in `extends:`:

- Schema augmentation adds `orgs`, `memberships`, `org_apps`, `org_role_overrides` tables and adds `org_id` columns to `custom_roles` + `activity_logs`.
- Migrations: `tenancy_001_*` through `tenancy_020_*` plus per-app `*_T<NNN>_*.ts` files that retrofit each layer's tenant tables. Core's migrations Nitro plugin discovers `_T<NNN>_` files via `runtimeConfig.tenancyMigrationPaths` (set by the layer's `tenant-migrations` module). In single-tenant deploys those files exist on disk but never run.
- Per-app tenancy migrations call `enableTenantScoping(db, '<table>')` (a helper inlined in each migration to avoid alias-resolution at migration-load time) — adds `org_id NOT NULL DEFAULT current_org_id() REFERENCES orgs(id) ON DELETE CASCADE` plus the missing-safe RLS policy. The `current_org_id()` Postgres function reads the GUC.
- DB role split: `host_admin` (BYPASSRLS, exposed as `adminDb` from `#tenant/admin-db`, used by migrations + `/api/admin/orgs/...` endpoints) and `app_user` (RLS-enforced, the default `db` from [layers/core/server/utils/database.ts](layers/core/server/utils/database.ts)). Single deploys use only `DATABASE_URL`; multi deploys add `APP_DATABASE_URL`.
- Nitro middleware reads `X-Active-Org` header (or path parameter for `/api/o/<slug>/...` and `/admin/orgs/:id/...` routes) and writes `event.context.{orgId,orgSlug,orgName,orgRoles}`. Does NOT set the GUC — `defineTenantHandler` does that inside its transaction.
- Operator admin (`users.is_admin`) lives in core in both modes. The thing tenancy adds on top is BYPASSRLS for cross-org reach.

### Migrations

[layers/core/modules/migrations.ts](layers/core/modules/migrations.ts) (a Nuxt module) walks `nuxt.options._layers` at config time and collects every layer's `migrations/` folder. The Nitro plugin [layers/core/server/plugins/migrations.ts](layers/core/server/plugins/migrations.ts) reads those paths plus the host's own `migrations/` directory and runs Kysely's `Migrator` over the union on boot. Tenancy migrations (filename pattern `*_T<NNN>_*.ts`) are only included when the tenancy layer is loaded; they're suffixed `zzz_` internally to force them to sort after every other layer's regular migrations.

Migration filenames must be globally unique across host + all layers. Convention: `<appId>_NNN_<description>.ts` for regular migrations; `<appId>_T<NNN>_<description>.ts` for per-app tenancy retrofits.

**Committed migrations are immutable. Never squash, edit, rename, renumber or delete a migration file once it has been committed** — not even on an unreleased feature branch, and not to "tidy up before release". Every schema change, fix-up or reversal goes in a **new** migration. Kysely tracks migrations by name only, so any database that already ran the old file (another developer's checkout, a branch deploy, a host pinned to a local layer path) never re-runs it and silently misses whatever the rewrite added — e.g. helpinator `ec05e74` folded `008`–`011` into `001`–`007`, leaving existing DBs without `run_heartbeat_at`. Patch-on-patch migration history is fine; a drifted database is not. The only exception is a migration that has never left your machine (uncommitted) — and if in doubt, ask.

Database is Postgres via Kysely + `kysely-postgres-js`. Schema composed: core tables in [layers/core/server/database/schema.ts](layers/core/server/database/schema.ts); layers extend the `Database` interface via module augmentation in their own `server/database/schema.d.ts`.

### Other notable bits

- **SSR is off** (`ssr: false`) — this is a SPA.
- The default layout (in core) renders launcher rail + per-app sidebar around all authenticated pages. App-layer pages render their own content.
- Auth is JWT-based; `requireAuth(event)`, `requireOperatorAdmin(event)`, and `defineTenantHandler` from `#tenant/server` are the gatekeepers for server routes.
- App-id prefix everything — paths, tables, migration names, permissions, components, composables.

## Conventions for cross-layer imports

| Symbol | Import from |
|---|---|
| Tenant context (server) | `#tenant/server` |
| Tenant composables (client) | `#tenant` |
| Email | `#email` |
| Core utilities (server-side) | `#core/server/utils/<name>` |
| Core utilities (client-side) | `#core/app/utils/<name>` |
| Core schema types | `#core/server/database/schema` |
| Core composables/components | auto-imported (no explicit import needed) |
| Permission interface (`#permissions`) | `#permissions` |

## User instruction reminders

- App-layer pages live at `app/pages/<appId>/...`. Don't write them with org-slug prefixes — the tenancy layer adds those automatically when loaded.
- Layer code that touches the database imports `db` from `#core/server/utils/database`. Only the tenancy layer imports `adminDb` (via `#tenant/admin-db`); doing so from outside that layer is a tenancy contract violation.
- Server route handlers that need user identity / permissions use `defineTenantHandler` from `#tenant/server`. In single mode it's just `requireAuth` + a transaction; in multi mode it adds the org context.
- Run dev/build/test commands from `dev/`, not from the repo root.
- Never squash, edit, rename or delete a committed migration — add a new one (see [Migrations](#migrations)).
