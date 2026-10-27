# Layer system

This repo is built as a **host shell + a stack of layers** wired together via Nuxt's [`extends:`](https://nuxt.com/docs/guide/going-further/layers). Each app (Calendar, Kanban, …) is its own layer; auth/admin/profile/launcher chrome stays in the host. Tenancy is itself an optional layer ([layers/tenancy/](../layers/tenancy/)). Adding an app means one line in `extends:` and one Nitro plugin that calls a few `register*()` functions at boot.

App layer code stays **tenancy-agnostic** — it imports server helpers from `#tenant/server` and composables from `#tenant`, and the same code runs in single-tenant deployments (no `layers/tenancy/`) and multi-tenant deployments (with the layer). The kernel's two implementations swap based on whether the tenancy layer is loaded.

For background and the full decision trail see [context/plans/multi-tenancy-layer/README.md](../context/plans/multi-tenancy-layer/README.md). This doc is the practical "how to" guide.

---

## Layers in this repo

All layers are tracked source under `layers/`. Each is a workspace package named `@nuxtinator/<id>`; the host extends them by name via standard node module resolution. See [dev-setup.md](dev-setup.md#how-layers-are-wired) for the resolution mechanics.

| Layer | Lives at | Purpose |
|---|---|---|
| `tenancy` | [layers/tenancy/](../layers/tenancy/) | **Optional.** Adds orgs/memberships/RLS/multi-mode kernel. Omit from `extends:` to deploy single-tenant. |
| `oauth` | [layers/oauth/](../layers/oauth/) | OAuth 2.1 server. Localized from `nuxt-blueprints` for the duration of the tenancy refactor. |
| `mcp` | [layers/mcp/](../layers/mcp/) | MCP server transport. Same localization story. |
| App layers (`calendar`, `kanban`, …) | [layers/apps/<id>/](../layers/apps/) | Per-app code. |

Edit any layer's source directly here. Port-back to `nuxt-blueprints` is documented in [context/plans/multi-tenancy-layer/](../context/plans/multi-tenancy-layer/) but not yet executed.

---

## What the host owns

The host shell stays thin. App layers feed it through **seven in-process registries** in [server/utils/](../layers/core/server/utils/):

| Registry | File | What you call |
|---|---|---|
| Permissions | [permissions-registry.ts](../layers/core/server/utils/permissions-registry.ts) | `registerPermissions(perms, meta?)` |
| Default grants | [default-grants-registry.ts](../layers/core/server/utils/default-grants-registry.ts) | `registerDefaultGrants(appId, { admin: [...], member: [...] })` |
| App static roles | [roles-registry.ts](../layers/core/server/utils/roles-registry.ts) | `registerStaticRole({ key, name, description, permissions, source })` |
| App entries (launcher tiles) | [app-registry.ts](../layers/core/server/utils/app-registry.ts) | `registerApp({ id, title, path, icon, requiredPermission, order })` |
| In-app nav items | [nav-registry.ts](../layers/core/server/utils/nav-registry.ts) | `registerNavItem({ appId, title, path, icon, requiredPermission, order })` |
| Rail entries | [rail-registry.ts](../layers/core/server/utils/rail-registry.ts) | `registerRailItem({ appId, id, title, path, icon, requiredPermission, order })` |
| Admin shell sections | [admin-section-registry.ts](../layers/core/server/utils/admin-section-registry.ts) | `registerAdminSection({ appId, title, path, icon, requiredPermission, order })` |

Layers feed these at boot from a Nitro plugin. The host bridges each registry to the client via auth-gated, permission-filtered endpoints (`/api/_apps`, `/api/_nav`, `/api/_admin-sections`) consumed by composables (`useApps`, `useAppNav`, `useAdminSections`).

### The app rail

The rail on the left of every page lists one entry per app by default. An app that registers rail items shows those instead, so one app can contribute several entries. Each item shows while its app is on for the org and the user holds `requiredPermission`; paths take the single-tenant form or `/@:orgSlug/...`. Items and apps sort together on one `order` scale. The app's unread badge goes on its item at the app's own path, else on its first item.

```ts
// host server/plugins/rail.ts
import { registerRailItem } from '#core/server/utils/rail-registry'
import { configureApp } from '#core/server/utils/app-registry'

export default defineNitroPlugin(() => {
  registerRailItem({ appId: 'pt', id: 'dashboard', title: 'Dashboard', path: '/pt', icon: 'i-lucide-layout-dashboard', order: 10 })
  registerRailItem({ appId: 'pt', id: 'campaigns', title: 'Campaigns', path: '/pt/campaigns', icon: 'i-lucide-flag', order: 20, requiredPermission: 'pt.campaigns.read' })
  // Relabel, re-icon and move an installed app without editing its layer.
  configureApp('crm', { title: 'Intercessors', icon: 'i-lucide-users', order: 45 })
})
```

`configureApp` applies wherever the app appears (rail, launcher, `/admin/apps`, MCP), whichever plugin runs first. It also takes `defaultStatus`, which replaces the layer's registry default (a host admin's choice on `/admin/apps` still wins), so a host decides in code which installed apps are on by default.

The rail shows icons only, with a toggle at the bottom that shows names next to them. Each browser remembers its choice; the mobile drawer always shows names. A host sets the rest in its `app.config.ts`:

```ts
export default defineAppConfig({
  rail: {
    expanded: true,     // start with names shown (default false)
    launcher: false,    // hide the "All apps" link (default true)
    orgSettings: false  // hide tenancy's organization settings link (default true)
  }
})
```

`launcher` also takes `{ title, icon, path }` to point the top link somewhere other than the app launcher, e.g. `{ title: 'Your sites', icon: 'i-lucide-church', path: '/orgs' }`. It shows on every page, inside an org or not, and is highlighted on `path` and the pages under it.

The host itself ships **no** permissions or roles — operator-admin is the `users.is_admin` boolean (no slug), checked via `requireOperatorAdmin(event)` from [tenant-kernel/server.ts](../layers/core/tenant-kernel/server.ts).

The `admin` role gets every registered permission. A host keeps a layer's permission from admins with `withholdFromAdmin` from a Nitro plugin, e.g. `withholdFromAdmin(['crm.schema.manage'])` to keep the CRM's schema builder from org admins; users then hold it only through another role or a per-user grant.

### A host's own account page

Core's `/account` page is a few `<SettingsGroup title="…">` cards, each stacking row components: `AccountAvatar`, `AccountDisplayName`, `AccountMemberSince`, `AccountEmail`, `AccountPassword`, `AccountSignInMethods` (one row per provider), `AccountSessions`, `AccountAppearance`, `AccountSignOut` and `AccountDelete`. Rows that edit something open their form under the row when clicked, one at a time. `AccountSections` renders the cards other layers register, such as OAuth's Connected apps, and goes between groups. A host that wants an account page in its own layout writes a page that groups the rows it wants, plus `<ReauthModal />`. It then points core at that page so the email-change and provider-link flows return there:

```ts
// nuxt.config.ts
runtimeConfig: { public: { accountPath: '/profile' } }
```

`AccountAvatar` offers uploads only when public S3 storage is configured (`S3_ENDPOINT`, the access keys, `S3_BUCKET_NAME` and `S3_PUBLIC_BASE_URL`; `S3_PUBLIC_BUCKET_NAME` alone isn't enough); without it, the row shows the avatar and can remove it.

---

## The `#tenant` kernel

App layer code imports tenancy helpers from two aliases:

- `#tenant` — client composables (`useActiveOrg`, `useMaybeActiveOrg`, `useTenantFetch`, `getActiveSlug`)
- `#tenant/server` — server helpers (`defineTenantHandler`, `requireOperatorAdmin`, `getUserPermissionsAcrossOrgs` / `getUserPermissionsForRequest` for out-of-request permission reads such as OAuth scope filtering, `getEnabledAppsForRequest` for the MCP app gate, `encodeFlowOrg` / `decodeFlowOrg`, `enableTenantScoping` for migrations)

Two implementations ship — one in the host, one in [layers/tenancy/](../layers/tenancy/). The tenancy layer's [tenant-kernel module](../layers/tenancy/modules/tenant-kernel.ts) registers the alias first; the host's [tenant-kernel module](../layers/core/modules/tenant-kernel.ts) only registers if no other module did. Effect: tenancy version wins when present, single-mode is the fallback.

**Single-mode contract:**
- `defineTenantHandler({ appId? }, fn)` — `requireAuth(event)` → opens transaction → calls `fn(tx, { userId, orgId: null, orgSlug: null, role: null, perms })`. No GUC, no app-enable check.
- `useActiveOrg()` throws (caller used wrong API for code that runs in either mode — use `useMaybeActiveOrg()` instead).
- `useMaybeActiveOrg()` returns `null`. `getActiveSlug()` returns `null`.

**Multi-mode contract** (when [layers/tenancy/](../layers/tenancy/) is in `extends:`):
- `defineTenantHandler({ appId? }, fn)` — `requireAuth` + reads `event.context.{orgId, orgSlug, orgRoles}` (set by the [tenancy Nitro middleware](../layers/tenancy/server/middleware/00.tenancy-context.ts)) → opens transaction → runs `SET LOCAL app.current_org = '<orgId>'` *inside the transaction* → 410s if `appId` is disabled for the org → calls `fn(tx, { userId, orgId, orgSlug, role, perms })`. The GUC is only set inside the handler's transaction; middleware never sets it because `SET LOCAL` is transaction-scoped.
- `useActiveOrg()` returns `{ slug, id, role }` from `route.params.orgSlug`.
- `useMaybeActiveOrg()` returns same; both return null on global routes.

---

## Creating a new app layer

Worked example: a "Tasks" app with permissions `tasks.access`, `tasks.read`, `tasks.write`.

### 1. Lay down the directory structure

```
layers/apps/tasks/
  dev/nuxt.config.ts
  package.json
  app/
    pages/
      tasks/
        index.vue
    utils/
      permissions.ts
  server/
    plugins/
      register-tasks.ts
    routes/api/tasks/
      index.get.ts
  migrations/
    tasks_001_create_tasks_table.ts
    tasks_T010_enable_tenancy.ts          (optional; only runs when tenancy layer is loaded)
```

Note: server routes for layers go under `server/routes/api/` (not `server/api/`). Pages stay at `app/pages/tasks/...` — single-tenant shape always; the tenancy layer's `pages:extend` hook adds `/@:orgSlug/tasks/...` aliases automatically.

### 2. dev/nuxt.config.ts and package.json

```ts
// layers/apps/tasks/dev/nuxt.config.ts
export default defineNuxtConfig({})
```

```json
// layers/apps/tasks/package.json
{
  "name": "layer-tasks",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "nuxt": "^4.0.0",
    "vue": "^3.0.0"
  }
}
```

If your layer imports a package that no other layer needs (e.g. a charting library, a parser), add it to `dependencies`. Anything shared with host or other layers — `kysely`, `kysely-postgres-js`, `postgres`, `h3`, `@nuxt/kit`, `@nuxt/ui`, `tailwindcss` — goes in `peerDependencies` so it resolves to the host's installed copy rather than getting duplicated under `.c12/` in production. Don't add a `main` field — Nuxt generates a `/// <reference types="layer-<id>" />` and TS would resolve it through `main`, picking up nuxt.config.ts in a context that breaks the typecheck.

#### Requiring other layers

Cross-layer imports (`#core/...`, another app layer's composables) are declared as `"*"` in `optionalDependencies` so module resolution works — that entry never carries a version. When your layer needs another layer to be present, or needs a minimum version of it (because it imports something that layer only gained in a later release), say so in `nuxtinator.requires`:

```json
// layers/apps/tasks/package.json
{
  "optionalDependencies": { "@nuxtinator/core": "*" },
  "nuxtinator": {
    "requires": { "@nuxtinator/core": ">=2.2.0" }
  }
}
```

Keys are package names, values are semver ranges (`"*"` = must be loaded, any version). Three things read it:

- **`layers:update` / `layers:check`** (and the weekly layer-update PR) in a host pick, per layer, the newest version its policy allows whose requirements the others' picked versions meet. A layer whose newest release needs more than the host can resolve is held at an older release and reported. If no compatible set exists, nothing is written and the script exits non-zero.
- **The build** (core's `layer-versions` module) checks every loaded layer's requirements. When both sides were fetched into the host's `_layers/`, an unmet requirement stops the build with e.g. `@nuxtinator/social-auth 0.3.0 needs @nuxtinator/core >=2.2.0 (loaded: 2.1.0)`. Layers loaded from anywhere else (this monorepo's workspace, a `NUXTINATOR_<ID>_PATH` checkout, a host's `apps/`) only warn, since their `version` lags their unreleased code. `/admin/updates` badges unmet requirements too.
- **`bun run release`** refuses to tag a layer while a monorepo layer it requires has no pushed release in range — release the dependency first.

Raise the minimum in the same change that starts using the new thing, so it ships with the release that needs it.

Then add the layer to the workspace in the root [package.json](../package.json):

```json
// /package.json (workspace root)
{
  "workspaces": [
    "dev",
    "layers/core",
    ...,
    "layers/apps/tasks"
  ]
}
```

### 3. Declare permissions

```ts
// layers/apps/tasks/app/utils/permissions.ts
export const TASKS_PERMISSIONS = [
  'tasks.access',
  'tasks.read',
  'tasks.write'
] as const

export type TasksPermission = typeof TASKS_PERMISSIONS[number]

export const TASKS_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'tasks.access': { title: 'Access Tasks', description: 'Required to open the Tasks app.' },
  'tasks.read':   { title: 'Read tasks',   description: 'View tasks.' },
  'tasks.write':  { title: 'Edit tasks',   description: 'Create, edit, and delete tasks.' }
}

// Default grants are role-name keyed. In single-tenant mode the keys map to
// host static roles; in multi-tenant mode they map to per-org roles. Same
// declaration either way.
export const TASKS_DEFAULT_GRANTS = {
  member: ['tasks.access', 'tasks.read'],
  admin:  [...TASKS_PERMISSIONS]
} as const

declare module '#permissions' {
  interface PermissionRegistry {
    'tasks.access': true
    'tasks.read': true
    'tasks.write': true
  }
}
```

### 4. The Nitro plugin

```ts
// layers/apps/tasks/server/plugins/register-tasks.ts
import { registerPermissions } from '~~/server/utils/permissions-registry'
import { registerDefaultGrants } from '~~/server/utils/default-grants-registry'
import { registerApp } from '~~/server/utils/app-registry'
import { registerNavItem } from '~~/server/utils/nav-registry'
import {
  TASKS_PERMISSIONS,
  TASKS_PERMISSION_META,
  TASKS_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(TASKS_PERMISSIONS, TASKS_PERMISSION_META)
  registerDefaultGrants('tasks', TASKS_DEFAULT_GRANTS)

  // Single-tenant-shape paths. The tenancy layer's `pages:extend` hook
  // adds `/@:orgSlug/tasks/...` aliases automatically when loaded.
  registerApp({
    id: 'tasks',
    title: 'Tasks',
    path: '/tasks',
    icon: 'i-lucide-list-todo',
    requiredPermission: 'tasks.access',
    order: 30
  })

  registerNavItem({
    appId: 'tasks',
    title: 'All tasks',
    path: '/tasks',
    icon: 'i-lucide-list',
    requiredPermission: 'tasks.read',
    order: 10
  })
})
```

### 5. Server route — `defineTenantHandler`

```ts
// layers/apps/tasks/server/routes/api/tasks/index.get.ts
import { defineTenantHandler } from '#tenant/server'

export default defineTenantHandler({ appId: 'tasks' }, async (tx, ctx) => {
  // ctx.userId is always present.
  // ctx.orgId / ctx.orgSlug are non-null in multi mode, null in single mode.
  // tx is a Kysely transaction; in multi mode `app.current_org` is set
  // inside it so RLS scopes reads/writes automatically.
  return await tx
    .selectFrom('tasks')
    .selectAll()
    .execute()
})
```

If you want to gate by permission, check `ctx.perms`:

```ts
export default defineTenantHandler({ appId: 'tasks' }, async (tx, ctx) => {
  if (!ctx.perms.has('tasks.write')) {
    throw createError({ statusCode: 403, statusMessage: 'Permission required: tasks.write' })
  }
  // ...
})
```

### 6. Pages

```vue
<!-- layers/apps/tasks/app/pages/tasks/index.vue -->
<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

// In multi mode this returns the active org; in single mode it's null.
// Use `useActiveOrg()` instead if your page is org-scoped only (it'll throw
// in single mode, surfacing the misuse loudly).
const org = useMaybeActiveOrg()

// Plain `useFetch` works in both modes — the tenancy layer's fetch
// interceptor injects `X-Active-Org` automatically when present.
const { data } = await useFetch('/api/tasks')
</script>

<template>
  <div>
    <h1>Tasks</h1>
    <pre>{{ data }}</pre>
  </div>
</template>
```

The default layout (host) renders the launcher rail + per-app sidebar around your page. Internal `<NuxtLink>`s preserve the `/@<slug>/` prefix automatically via the tenancy router guard.

A page that should *not* be org-prefixed — a public bridge or callback that owns no org context — opts out with `definePageMeta({ tenantExempt: true })`. The tenancy route guard then leaves it at its naive path instead of rewriting to `/@<slug>/…` or bouncing to `/orgs`, so a layer can exempt its own route without editing the guard. In single mode there's no guard, so the flag is a harmless no-op.

Follow the UI rules in [layers/core/DESIGN.md](../layers/core/DESIGN.md): use core's components (`InfoTip`, `SidebarPanel`, `SettingsGroup`/`SettingsRow`, `useConfirm`/`ConfirmModal`) and theme tokens rather than hand-rolled markup and raw colors.

### 7. Wire it into the host

Three places to update (in this order):

```ts
// 1. dev/layers.ts — add the new entry to LAYERS (in load order: app layers go after core/tenancy/email/oauth/mcp and before dev)
export const LAYERS = [
  { id: 'core',     pkg: '@nuxtinator/core' },
  { id: 'tenancy',  pkg: '@nuxtinator/tenancy' },
  { id: 'oauth',    pkg: '@nuxtinator/oauth' },
  { id: 'mcp',      pkg: '@nuxtinator/mcp' },
  { id: 'messages', pkg: '@nuxtinator/messages' },
  { id: 'videos',   pkg: '@nuxtinator/videos' },
  { id: 'tasks',    pkg: '@nuxtinator/tasks' },   // new
  { id: 'dev',      pkg: '@nuxtinator/dev' }
] as const
```

```jsonc
// 2. dev/package.json — add the workspace dep so bun creates the symlink
"dependencies": {
  // ...
  "@nuxtinator/tasks": "workspace:*"
}
```

```jsonc
// 3. package.json (root) — add to the workspaces array
"workspaces": ["dev", ..., "layers/apps/tasks"]
```

`dev/nuxt.config.ts`'s `extends:` is derived from `LAYERS.map(l => layer(l.pkg))` — don't edit it directly. The `layer()` helper passes the package name through to node module resolution; set `NUXTINATOR_TASKS_PATH=…` in `dev/.env` to point this layer at a sibling checkout instead of the workspace symlink.

For downstream consumers, also add a matching entry to [prod/layers.ts](../prod/layers.ts) — same `{ id, pkg }` plus a `url` field with the giget source.

### 8. Install + restart

```
bun install              # from repo root, picks up the new workspace
cd dev && bun run dev
```

The launcher rail now shows the Tasks tile. Authenticated users with `tasks.access` see it; admins (in either mode) see everything.

---

## Optional bits

### App-static roles

If your layer wants to ship a role like `tasks-admin` that operators can assign without manually composing permissions, use `registerStaticRole`:

```ts
import { registerStaticRole } from '~~/server/utils/roles-registry'

registerStaticRole({
  key: 'tasks-admin',
  name: 'Tasks Admin',
  description: 'Full administrative access to Tasks.',
  permissions: [...TASKS_PERMISSIONS],
  source: 'tasks'
})
```

App-static role keys are kebab-case with the app-id prefix by convention (`tasks-admin`, not `admin` or `taskAdmin`).

### Admin sections

Drop a page at `layers/apps/tasks/app/pages/admin/tasks/index.vue` with `definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] })`, then register it:

```ts
import { registerAdminSection } from '~~/server/utils/admin-section-registry'

registerAdminSection({
  appId: 'tasks',
  title: 'Tasks settings',
  path: '/admin/tasks',
  icon: 'i-lucide-settings',
  requiredPermission: 'tasks.write',
  order: 50
})
```

`/admin/...` routes don't get the `@<slug>` prefix — they're host-admin tooling.

### Personal apps

An app whose data belongs to each user, not to an org (a personal list, location sharing between people in different orgs), is a personal app. It is the same in every org and is turned on per user.

```ts
// nuxt.config.ts — build-time: keeps its pages at the bare path in every org
export default defineNuxtConfig({
  runtimeConfig: { public: { personalApps: { notes: '/notes' } } }
})

// server/plugins/register-notes.ts
registerPermissions(NOTES_PERMISSIONS, NOTES_PERMISSION_META)
registerApp({
  id: 'notes',
  title: 'Notes',
  path: '/notes',
  requiredPermission: 'notes.access',
  scope: 'user',
  permissions: [...NOTES_PERMISSIONS], // held by every user the app is on for
  defaultStatus: 'host_controlled' // 'default' = every signed-in user
})
// no registerDefaultGrants: roles grant personal-app permissions nothing
```

Handlers use `withUserPermission` from `#core/server/utils/personal-apps` instead of `withOrgPermission`; `ctx.userId` is the caller and `app.current_user` is set for RLS:

```ts
import { withUserPermission } from '#core/server/utils/personal-apps'

export default defineEventHandler(event =>
  withUserPermission(event, { appId: 'notes' }, 'notes.read', (tx, ctx) =>
    tx.selectFrom('notes_items').selectAll().where('user_id', '=', ctx.userId).execute()))
```

Tables carry `user_id`, no `org_id`, and no `_T<NNN>_` migration. Enable RLS in the regular migration:

```ts
await sql`ALTER TABLE notes_items ENABLE ROW LEVEL SECURITY`.execute(db)
await sql`
  CREATE POLICY user_isolation ON notes_items FOR ALL
    USING      (user_id = nullif(current_setting('app.current_user', true), '')::uuid)
    WITH CHECK (user_id = nullif(current_setting('app.current_user', true), '')::uuid)
`.execute(db)
```

A host admin turns an invite-only personal app on per user from `/admin/users` (or ticks it in the invite form). [list-of-100](../layers/apps/list-of-100/) is the worked example.

### Database tables

Create a `server/database/schema.d.ts` and merge your tables into core's global
`NuxtinatorDatabaseTables` registry:

```ts
// layers/apps/tasks/server/database/schema.d.ts
import type { ColumnType, Generated } from 'kysely'

export interface TasksTable {
  id: Generated<string>
  created: ColumnType<Date, string | undefined, string>
  updated: ColumnType<Date, string | undefined, string>
  user_id: string
  title: string
  done: Generated<boolean>
}

declare global {
  interface NuxtinatorDatabaseTables {
    tasks: TasksTable
  }
}
```

Use `declare global`, **not** `declare module '#core/server/database/schema'`.
Core joins `NuxtinatorDatabaseTables` into its `Database` type, and global
interface merging is resolution-independent — it works the same whether `#core`
resolves via a workspace symlink, an npm package, or a `#core/* → _layers/*`
tsconfig `paths` alias in a downstream host. Path-aliased `declare module`
augmentation silently fails to merge in `_layers/`-style consumer hosts, leaving
every layer table invisible to Kysely. (To retrofit an extra column onto a core
table the same way, merge into the matching `Nuxtinator<Table>Columns` registry
core declares in [layers/core/server/database/schema.ts](../layers/core/server/database/schema.ts) — that's how the tenancy layer adds `org_id`.)

Note: don't include `org_id` here. The tenancy layer's per-app retrofit migration (see next section) adds it at the SQL level when loaded; in single mode it never exists. App code that reads from `tasks` works in both modes — RLS scopes the rows in multi mode automatically.

### Making tables tenant-scoped

If your tables should be isolated per-org in multi-tenant mode, add a per-app **tenancy migration**. Convention: filename ends in `_T<NNN>_<description>.ts`.

```
layers/apps/tasks/migrations/
  tasks_001_create_tasks_table.ts        (regular — runs always)
  tasks_T010_enable_tenancy.ts           (tenancy retrofit — only when layer is loaded)
```

```ts
// layers/apps/tasks/migrations/tasks_T010_enable_tenancy.ts
import type { Kysely } from 'kysely'
import { enableTenantScoping, disableTenantScoping } from '#tenant/server'

export async function up(db: Kysely<unknown>): Promise<void> {
  await enableTenantScoping(db, 'tasks')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await disableTenantScoping(db, 'tasks')
}
```

`enableTenantScoping` adds `org_id uuid NOT NULL DEFAULT current_org_id() REFERENCES orgs(id) ON DELETE CASCADE`, enables RLS, and adds the missing-safe `tenant_isolation` policy. The `current_org_id()` Postgres function reads `app.current_org` (set inside `defineTenantHandler`'s transaction), so INSERTs that don't specify `org_id` get the right value. Outside a transaction the column is `NULL` and the `NOT NULL` constraint blocks the insert — fail-loud, never wrong-org.

The tenancy layer's [tenant-migrations module](../layers/tenancy/modules/tenant-migrations.ts) discovers `*_T<NNN>_*.ts` files across layers and feeds them to the migrator only when the tenancy layer is loaded. In single mode they exist on disk but never run.

Tables that should *not* be org-scoped (e.g. global lookup tables) — just don't list them in your tenancy migration.

### Server APIs

Drop endpoints under `server/routes/api/<appId>/`. App layers under [layers/apps/](../layers/apps/) use Nitro's `server/routes/api/` (not `server/api/`).

```
layers/apps/tasks/server/routes/api/tasks/
  index.get.ts
  index.post.ts
  [id].put.ts
  [id].delete.ts
```

All wrapped in `defineTenantHandler({ appId: 'tasks' }, ...)`.

### Hook reference (multi-mode only)

The tenancy layer emits Nitro hooks layers can subscribe to. In single mode these hooks never fire — subscribing to them is harmless (no-op).

| Event | Payload | When |
|---|---|---|
| `org.created` | `{ orgId, slug, createdByUserId }` | New org row inserted. |
| `org.deleted` | `{ orgId, slug }` | Org is being deleted. Fires before the row cascade so subscribers can still read the org's rows (e.g. to collect S3 keys the cascade would strand). |
| `user.created` | `{ userId, email, viaInvite }` | New user row inserted. (Fires in both modes.) |
| `user.deleting` | `{ userId }` | Just before a user row is deleted, while everything tied to it still exists. (Both modes.) |
| `user.deleted` | `{ userId, avatar }` | After a user's deletion has committed. (Both modes.) |
| `user.verified` | `{ userId, email }` | User accepts invite or verifies email. (Both modes.) |
| `membership.created` | `{ membershipId, userId, orgId, roles, createdByUserId }` | Membership row inserted. |
| `membership.updated` | `{ membershipId, userId, orgId, oldRoles, newRoles }` | Roles changed. |
| `membership.deleted` | `{ membershipId, userId, orgId }` | Membership removed. |
| `app.enabled` | `{ orgId, appId }` | App turned on for an org. |
| `app.disabled` | `{ orgId, appId }` | App turned off for an org. |

```ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('membership.created', async (p) => {
    // bootstrap per-membership rows for your app
  })
})
```

### Long-running endpoints

`defineTenantHandler` holds a transaction (and a pooled connection) for the request lifetime. For SSE streams, large uploads, or anything that blocks for seconds:

- **Recommended**: use `defineTenantHandler` only for auth + initial data load + permission check; pull what you need into local variables; then run the long work outside the wrapper. Open a fresh short tenant handler for any write-back.
- **Fallback**: identity check (`requireAuth`) + `db` with hand-rolled `WHERE org_id = ?` predicates. This is a deliberate RLS opt-out — every query needs the predicate or it's a leak.

---

## Conventions

The single most important convention: **every surface the layer touches gets the app id as its prefix**. Two apps that collide on a path or table name break the layer model.

```text
App id:               tasks
UI routes:            /tasks/*               (tenancy adds /@:slug/tasks/* aliases automatically)
API routes:           /api/tasks/*           (org context via X-Active-Org header)
DB tables:            tasks, tasks_tags
Migrations:           tasks_001_*.ts, tasks_002_*.ts
Tenancy migrations:   tasks_T010_*.ts        (optional)
Permissions:          tasks.access, tasks.read, tasks.write
Components:           TasksList.vue, TasksRow.vue
Composables:          useTasksList.ts
Server utils:         server/utils/tasks-*.ts
OAuth/MCP scopes:     tasks.read, tasks.write   (same vocabulary as permissions)
Default-grants ns:    'tasks'
App-static role key:  tasks-admin (kebab-case, app-id prefix)
```

Permission strings use `.` (one namespace shared with OAuth/MCP scopes). DB tables use `_`. Avoid generic names — `/api/items`, `useItems.ts`, `001_create_items.ts` will collide the moment a second app ships.

---

## Install / uninstall

**Install:**
1. Add `"layers/apps/<id>"` to the `workspaces` array in the root [package.json](../package.json).
2. Add `"@nuxtinator/<id>": "workspace:*"` to `dev/package.json`'s `dependencies`.
3. Add `{ id: '<id>', pkg: '@nuxtinator/<id>' }` to the `LAYERS` array in [dev/layers.ts](../dev/layers.ts) (in load order).
4. `bun install` from root, then `bun dev` (or restart). Migrations run, the layer's plugin registers permissions/default-grants/app meta/nav/admin sections/static roles.
5. For consumers, mirror step 3 in [prod/layers.ts](../prod/layers.ts) with a `url` field (giget source).

**Uninstall:**
1. Remove the entry from `LAYERS` in `dev/layers.ts`, from `dev/package.json`'s deps, and from the workspace list in root `package.json`.
2. Restart. Registrations evaporate; the app disappears from the launcher.
3. **Migrations and tables are not auto-reverted.** Run a manual rollback if you want to fully tear down. Custom-role rows referencing the layer's permissions silently shed those strings (the runtime filters orphaned permissions through `isRegisteredPermission()`).

Reinstalling is idempotent.

---

## Working on the OAuth or MCP layer

These are tracked source under [layers/oauth/](../layers/oauth/) and [layers/mcp/](../layers/mcp/) — edit them in place. The eventual port-back to `nuxt-blueprints` is documented in [context/plans/multi-tenancy-layer/](../context/plans/multi-tenancy-layer/).

The OAuth and MCP layers consume the host's permission registry directly — `isRegisteredPermission(scope)` (validators) and `getAllPermissions()` (advertisement). You don't register OAuth or MCP scopes separately. Adding a permission via `registerPermissions(...)` makes it a valid OAuth scope and a valid MCP tool/resource scope automatically.

---

## Tenancy layer specifics

When [layers/tenancy/](../layers/tenancy/) is in `extends:`:

### Two DB roles + transaction-pool requirement

- `host_admin` (BYPASSRLS) — used by migrations + cross-org `/api/admin/orgs/...` endpoints. Exposed as `adminDb` from `#tenant/admin-db`. **Layer code outside the tenancy layer must never import this.**
- `app_user` (RLS-enforced) — the default for the host's `db` and for layer code.

Connection URLs: `DATABASE_URL` for `host_admin`, `APP_DATABASE_URL` for `app_user`. Single-tenant deploys can set only `DATABASE_URL` — the host's `db` falls back to it.

If you deploy through a connection pooler, configure transaction-pooling mode. `defineTenantHandler` uses `SET LOCAL`, which is transaction-scoped; session-pooling would leak `app.current_org` across requests. `prepare: false` is configured on the postgres-js driver to remain compatible with PgBouncer txn-pool.

### URL shape

In multi mode, app pages mount at `/@:orgSlug/<app>/...` via `pages:extend` aliasing. APIs always live at `/api/<app>/...`; the org slug travels in an `X-Active-Org` header that the tenancy layer builds into the global `$fetch` instance via its [fetch-template module](../layers/tenancy/modules/tenant-fetch-template.ts). MCP tools instead take an optional `org` slug input, falling back to the same header.

The tenancy layer's own pages live at `/@<slug>/settings/*` (org settings), `/orgs` (picker), `/orgs/new` (create org), `/admin/orgs` (host admin).

### Org-creation slug shape

Slugs match `^[a-z0-9-]{2,40}$`. With the `@` URL prefix, no slug can collide with any system route — the leading `@` is the disambiguator. No reserved-name list, no in-memory Set.
