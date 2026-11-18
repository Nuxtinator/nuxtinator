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

An app registered with `launcher: false` stays installed and on (its routes, API and page guard work as usual) but gets no launcher tile or rail entry; other apps or settings pages link to its pages. The records kernel uses it: members see records through Views, and admins manage record types from org settings.

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

The `admin` role gets every registered permission. A host keeps a layer's permission from admins with `withholdFromAdmin` from a Nitro plugin, e.g. `withholdFromAdmin(['records.schema.manage'])` to keep the records schema builder from org admins; users then hold it only through another role or a per-user grant.

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

`nuxtinator.requires` is about loading. When your app also can't work in an org unless another org app is on there (meetings stores its action items as records tasks and shows them through views), say so on the app too: `registerApp({ ..., requires: ['records', 'views'] })`. With tenancy loaded, an org that has your app on has those on as well (unless the host disabled one, or turns it on per org with Host-controlled), and nobody can turn them off for that org while your app is on; the org's Apps page shows "Required by …". Nothing is stored for it.

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
  defaultStatus: 'host_controlled' // 'default' = every signed-in user, 'admins' = host admins only
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

A host admin turns an invite-only personal app on per user from `/admin/users` (or ticks it in the invite form), or for whole host groups from `/admin/apps` → Users; groups themselves are managed on `/admin/groups`. RLS on these tables holds only when the app connects as `app_user` — see [database-roles.md](database-roles.md). [list-of-100](../layers/apps/list-of-100/) is the worked example.

#### Sharing personal items

A personal item (a tree, a list, a collection) is shared with people, as a viewer or an editor. Each shareable resource gets its own share table, made in the app's migration by core's helper:

```ts
// migrations/notes_002_note_shares.ts
import { createShareTable, dropShareTable, sharedWithMe, CURRENT_USER_SQL } from '@nuxtinator/core/share-tables'

const SPEC = { table: 'notes_note_shares', resourceTable: 'notes_items', ownerColumn: 'user_id' }

export async function up(db: Kysely<unknown>) {
  await createShareTable(db, SPEC)
  await sql.raw(`DROP POLICY user_isolation ON notes_items`).execute(db)
  await sql.raw(`CREATE POLICY notes_read ON notes_items FOR SELECT USING (
    user_id = ${CURRENT_USER_SQL} OR ${sharedWithMe(SPEC, 'notes_items.id')}
  )`).execute(db)
  await sql.raw(`CREATE POLICY notes_write ON notes_items FOR ALL
    USING (user_id = ${CURRENT_USER_SQL}) WITH CHECK (user_id = ${CURRENT_USER_SQL})`).execute(db)
}
export async function down(db: Kysely<unknown>) { await dropShareTable(db, SPEC) }
```

`sharedWithMe(SPEC, expr, { role: 'editor' })` limits a policy to editor shares; child tables pass the expression naming their resource. Qualify `expr` with its table (`notes_items.id`, not `id`), or it binds to the share table's own `id`. Register the table at boot, and mount the share routes:

```ts
// server/plugins/register-notes.ts
registerShareTable({ appId: 'notes', table: 'notes_note_shares' })

// server/routes/api/notes/items/[id]/shares/index.ts, …/shares/[shareId].ts and …/shares/[shareId]/resend.post.ts
export default defineShareHandler({ appId: 'notes', table: 'notes_note_shares', permission: 'notes.read' })
```

The page opens `<ShareDialog v-model:open :endpoint="`/api/notes/items/${id}/shares`" :title>`. The owner shares with a known person (someone who accepted a share from them, or whose share they accepted, in any app), by email invite, or by single-use link; nothing reaches anyone's account until they accept. A share invite creates an account only while self-registration is on, and stays off `/admin/invites`. Personal content goes with its owner: shares are deleted with the item. See [server/utils/shares.ts](../layers/core/server/utils/shares.ts).

### Limiting content to teams

An org app can let editors limit a container (a project, a portfolio) to some of the org's teams. The org's groups must run as teams (`/@<slug>/settings/groups`). It's enforced in app code by core's [team-access.ts](../layers/core/server/utils/team-access.ts), not by RLS, so the container table keeps its plain org policy.

1. In a regular migration, add `visibility text NOT NULL DEFAULT 'org'` (`org` | `teams`) to the container table and create `<app>_<container>_teams (container_id → container ON DELETE CASCADE, group_id → groups ON DELETE RESTRICT, PRIMARY KEY (container_id, group_id))`, indexed on `group_id`. Give the teams table a `_T` migration with the usual org scoping. Feedback's `feedback_012` / `feedback_T011` are the model.
2. Declare `<app>.all_teams` ("show all teams"), left out of member grants, and register the container from your Nitro plugin:

   ```ts
   registerTeamContainer({
     appId: 'feedback',
     table: 'projects',
     visibilityColumn: 'visibility',
     teamsTable: 'feedback_project_teams',
     allTeamsPermission: 'feedback.all_teams'
   })
   ```

   The registration also feeds the group-usage check, so a team in use can't be deleted and the org can't switch back to audiences.
3. In every member-facing route and MCP tool, resolve the scope once and check through it:

   ```ts
   return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
     const scope = await getTeamScope(event, tx, ctx, 'feedback')
     const rows = await tx.selectFrom('projects').selectAll().where(teamVisible(scope, 'projects')).execute()
     // by id or slug, and for children, with the container's id:
     await assertTeamAccess(tx, scope, 'projects', projectId) // 404
   })
   ```

   Moves check both containers. Create and update read `{ visibility, teamIds }` with `readContainerTeamsInput` and save them with `setContainerTeams`, which refuses teams the caller isn't on and saves that would lock them out. MCP tools take team names instead and turn them into ids with `resolveTeamNames`; `listPickableTeams` lists what the caller may pick. Notifications and emails about a container go through `filterRecipients`. Paths with no user (a public widget, a bot, a job looping over `listOrgScopes`) skip the helper and keep reaching every container.
4. In the UI, put `<TeamAccessField app-id v-model:visibility v-model:team-ids :current-teams>` in the container's create and settings forms and `<ShowAllTeamsToggle app-id @change>` in the app's chrome for holders of `<app>.all_teams`.
5. Test every route that takes an id or slug with a caller off the team, expecting 404.

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

#### Ordering across layers

Migrations run in two phases: every layer's regular migrations (`<app>_NNN_`), then, with tenancy loaded, every tenancy retrofit (`<app>_T<NNN>_`, keyed `zzz_`). Each phase is one pass sorted by name across all layers, so a migration that uses another layer's table must sort after the one that creates or renames it. The record kernel's tables are renamed from `crm_*` to `records_*` by `records_001`; a regular migration touching them must sort after it (a `crm_NNN` migration sorts before it, so such a change belongs in the records layer). Tenancy retrofits run after every rename, so `crm_T001`–`T003`, written against the old names, look up whichever name is in place.

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
| `user.updated` | `{ userId, fields }` | The user's `display_name` or `email` changed, from their profile or an operator's edit. (Both modes.) |
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

## Mail

All mail goes through one kernel, `@nuxtinator/mail` ([layers/mail/](../layers/mail/)). It is a framework-free package: it takes a Kysely instance and plain objects. Core wraps it for Nuxtinator apps (registries, routes, `/admin/email`, migrations `023`–`025`). Processes outside Nuxt on the same database import it directly.

| Export | Holds |
|---|---|
| `@nuxtinator/mail/kernel` | `createMail`, the types, `addressHash`, `notSuppressed`, `parseInbound`, the crypto helpers |
| `@nuxtinator/mail/adapters` | `mailgunProvider`, `sesProvider`, `sendgridProvider` |
| `@nuxtinator/mail/test` | `createFakeProvider` (delivers to Mailpit, takes HMAC-signed JSON events and raw-MIME inbound) |

### Streams

A stream is a kind of mail, defined in code. Core registers `account` (password resets, verification: `userInitiated`, `queued`) and `system` (everything else core sends: `queued`). A layer adds its own from its Nitro plugin:

```ts
import { registerMailStream } from '#core/server/utils/mail'

registerMailStream({
  id: 'newsletter',          // letters, digits, - and _
  label: 'Newsletter',
  defaultLocal: 'news',      // From local part; the domain always comes from resolution
  orgAssignable: true,       // follows the org's own domain when it has one
  bulk: true                 // the Streams tab warns when it shares a domain that posts delivered events
})
```

| Flag | Effect |
|---|---|
| `orgAssignable` | an org's own domain routes (its `*` switch and per-stream picks) apply |
| `needsReceive` | only domains that can also receive qualify (replies come back to them) |
| `userInitiated` | mail the person just asked for: skips suppressions, and gets past the provider's own list where it can. Keep it narrow |
| `queued` | `send()` writes an outbox row and attempts at once; failures are retried by the outbox |
| `maxAgeMinutes` | queued rows older than this fail as `expired` (default 24 hours). `expiresInMinutes` on a message overrides it |

**Which domain sends.** For `(stream, org)` the first qualifying candidate wins: the org's route for the stream, the org's `*` route (only for `orgAssignable` streams), the host's route for the stream, the host's `*` route (its default domain), then the env domain. A domain qualifies when its ownership and sending are verified (and receiving, for `needsReceive`). No candidate → `no_sender`: queued mail waits, nothing is dropped.

**Bulk streams** (reminders, newsletters) belong on their own domain. A domain that carries a `userInitiated` stream or a stream with a `delivered` handler subscribes to delivered events, one per message.

### Sending

```ts
import { sendMail, enqueueMail } from '#core/server/utils/mail'

// Now, on its own connection. Never inside a transaction.
const res = await sendMail({ stream: 'newsletter', orgId, to, subject, html, ref: issueId })

// Inside a handler's transaction: the outbox row commits with your work,
// and the first attempt runs right after commit. Nothing is sent on rollback.
await enqueueMail(tx, { stream: 'newsletter', orgId, to, subject, html })
```

`SendResult` is `sent` (with `messageId`, the Message-Id the recipient sees — thread on it), `suppressed`, `refused` (a send guard), `no_sender`, `failed` (`retryable` or not), `unknown` (timed out mid-call: treat as sent, never retry) or `queued`. A non-queued `send` makes one attempt: a caller with its own queue keeps the item due until `sent`, `suppressed` or a non-retryable failure; a caller without one uses a `queued` stream or `enqueueMail`.

`ref` (letters, digits, `-`, `_`, up to 64) comes back on every provider event for that message. Match events by `ref`, never by a provider id.

`#email` (`sendEmail`, `sendTemplateEmail`) stays for simple mail: it picks `account` or `system` from the template and returns a boolean.

### Inbound handlers, event handlers, send guards

```ts
registerInboundHandler({
  id: 'unsubscribe',
  order: 10,                                   // ascending; core's probe handler is 0, the inbox catch-all 1000
  match: ({ recipient }) => recipient.local.startsWith('unsubscribe+'),
  handle: async (mail, ctx) => 'handled'       // 'handled' | 'drop' | 'retry' (retry → 503, the provider retries)
})

registerMailEventHandler({
  id: 'newsletter:delivery',
  stream: 'newsletter',
  types: ['delivered', 'bounced'],
  handle: async (event) => { /* event.ref, event.orgId */ }
})

registerSendGuard({
  id: 'no-org-accounts',
  check: async (m, ctx) => ctx.accountOrgId ? { ok: false, reason: 'org accounts are off here' } : { ok: true }
})
```

Inbound mail is dispatched once per receiving recipient, only for an ownership-verified domain whose receiving account is the one the webhook arrived on, so handlers must be idempotent. A guard that counts (throttling) keeps its counters in the database, since several processes send.

### Suppressions and trust

The kernel is the only authority on bounces and complaints, and stores only address hashes.

| Event | Host-owned account | Org-owned account |
|---|---|---|
| permanent bounce | global hard bounce | hard bounce for that org |
| complaint | the org named by the message (`nx-org`), else the host | that org; the message's org is ignored |
| delivered | clears an older global hard bounce | clears only that org's |

An org holds the signing key of its own provider account, so its events only ever affect that org, and event handlers receive the account's org, not the one the event names. For set-based queries the same rule is SQL: `WHERE NOT mail_is_suppressed(email, org_id)`, or `notSuppressed(eb, 'c.email', 'c.org_id')` in Kysely.

Providers keep their own lists. Each domain's mode follows its key's capabilities: `disabled` (SES, with a configuration set that turns its list off), `mirrored` (Mailgun or SendGrid with a key that can change the lists: the kernel releases addresses it has cleared), `unmanaged` (the provider's list stays in charge; `/admin/email` says so).

### Providers

A provider is a plain object implementing `MailProvider` from `@nuxtinator/mail/kernel`. Core registers Mailgun, SES and SendGrid; a layer adds another from its Nitro plugin, before the mail instance is built:

```ts
import { registerMailProvider } from '#core/server/utils/mail'
import { postmarkProvider } from '../utils/postmark'

registerMailProvider(postmarkProvider)
```

| Member | What it does |
|---|---|
| `id`, `label` | the stored provider id (unique) and its name in the UI |
| `credentialFields` | the account form: `{ key, label, secret, optional?, help?, env?, forWebhooks?, advanced? }`. `env` names the variable that fills the field for the Environment account; `forWebhooks` marks a field needed to accept the provider's webhooks (a signing key), which a domain's check lists as a step until it's saved; `advanced` keeps a rarely needed field (Mailgun's account-wide API key) under More options when adding a domain |
| `domainCredentialFields` | optional per-domain key (a Mailgun sending key) |
| `supports` | `{ send, receive, events }`: which roles a domain may give it |
| `webhookScope` | `domain` (webhooks set per domain) or `account` (one webhook for the whole account, like SendGrid's); the kernel works out the event list across the account's domains |
| `notes` | optional `{ send?, receive? }` caveats, shown where an admin picks the provider or sets a domain up on it |
| `verifyCredentials(creds, domain?, opts?)` | checks the key with calls that change nothing and returns the capabilities it proved (`send`, `domains`, `routes`, `webhooks`, `suppressionLists`), and any `credentials` the key could read (Mailgun's webhook signing key, readable by an Admin key), which the kernel stores on the account |
| `manualSetup(domain, role, urls, { events })` | the steps an admin follows at the provider when setup isn't automatic. A step's `check` names the check that confirms it, so the domain's panel ticks it off |
| `inspectDomain?(creds, domain, urls, { events, receive })` | reads, without changing anything, what is set up at the provider for a domain set up by hand: whether the domain exists and the provider's verdict on its DNS records, which events don't post to the events URL yet (and old URLs of this app to remove), and whether a route forwards its mail here. Each part is `null` when the key can't read it. `checks` adds the provider's own named checks per role (SES: the configuration set, production access, each SNS topic's subscription; SendGrid: the signed event webhook, an event webhook that posts elsewhere, Inbound Parse in raw mode); a failing receive check holds the receiving probe back. Called only by an admin's Check; a webhook list that's complete marks the webhooks as set up. Mailgun, SES and SendGrid implement it |
| `send(creds, msg)` | one attempt; returns `sent` (with the provider's id), `failed` (`retryable`, and `keyRejected` when the key itself was refused) or `unknown` |
| `provisionDomain?`, `checkDomain?`, `configureWebhooks?`, `deprovisionDomain?` | automatic setup. Throw `ProviderPermissionError(capability)` when the key isn't allowed: the kernel records the capability as false and falls back to the manual steps |
| `providerSuppression` | `mode(capabilities)` (`disabled`, `mirrored`, `unmanaged`) and an optional `release(creds, domain, address, list)` |
| `handleWebhook(creds, req)` | verifies the signature and returns `handshake`, `events` (mapped to `MailEvent`s, with `stream`, `orgId` and `ref` from the message's correlation) or `inbound` (a parsed message), or `rejected` |

Capabilities are recorded one by one from calls the kernel needs, and a refusal never fails an add, a check or a send. `@nuxtinator/mail/test` has a fake provider whose capabilities and suppression mode are configurable; adapter tests run against a local fake HTTP server.

### Organizations' own domains

With tenancy loaded, an org adds its own domain on `/@<slug>/settings/email`. It must prove it controls the name before anything else happens:

1. The domain is created `pending`, with a token. The page shows one TXT record: `_nx-verify.<domain>` with the value `nx-verify=<token>`.
2. **Check now** looks the record up. Until it is found, nothing is called at any provider and the domain sends, receives and qualifies for nothing.
3. Found: the domain becomes `verified` and is set up on the host's accounts for organizations' domains (or on the org's own account, if it chose one). Every other org's row for the name is then deleted, so one name never has two live rows. A name a host domain holds can't be claimed.
4. A pending claim not verified within 7 days is deleted by the daily job.

The daily job then rechecks each org domain's record. One failed lookup changes nothing; three in a row set the domain `lapsed`: its streams fall back to the host's domains, it receives no inbound mail, the name is no longer held exclusively, and the org's admins are emailed. A passing check (the daily one, or **Check now**) restores it, unless another org has verified the name meanwhile.

Domains a host admin adds and the Environment domain are `verified` from the start.

### Outside Nuxt

A worker on the same database builds its own instance:

```ts
import { createMail } from '@nuxtinator/mail/kernel'
import { mailgunProvider } from '@nuxtinator/mail/adapters'
import { streams, guards } from './mail-config'   // the same module the app imports

const mail = createMail({ db, providers: [mailgunProvider], streams, guards, env: process.env, secretKey: process.env.NUXT_SECRET_ENCRYPTION_KEY })
mail.startSweeping()
process.on('SIGTERM', () => mail.stop())
```

- **Fetching the package.** `_layers/` is usually outside the Docker build context, so the worker image's build runs `bun run scripts/sync-layers.ts --only mail`, which fetches the tag pinned in `layers.lock.json`. It never resolves anything itself: with no lock entry for `mail` it stops with an error, so run `bun run layers:update` and commit the lock first.
- **Who holds what.** A sending process needs the database, the secret key (it decrypts every account's credentials) and the env account's provider variables. An enqueue-only process (a public server) gets only `outboxPublicKey` (`MAIL_OUTBOX_PUBLIC_KEY`, shown on `/admin/email`) and calls `enqueue`; a worker sends.
- **Identical env-account variables.** The env account's credentials are never stored; each process uses its own. The app records a fingerprint at boot, and a process whose variables differ pauses its env-account sends (queued rows wait) until they match. When rotating a key, redeploy the app first.
- **Connections.** `db` may be pooled (PgBouncer transaction mode, `prepare: false`): the kernel takes no advisory locks and never listens on it. To wake the sender on each enqueue, give `subscribe` a `LISTEN` on a direct connection (core does this when `MAIL_LISTEN_DATABASE_URL` is set); otherwise the sweep tick (`sweepSeconds`) is the trigger.
- **Webhooks** are only received by the Nuxt app.

### Environment

`MAILGUN_API_KEY` + `MAILGUN_DOMAIN` (or `MAIL_PROVIDER` with that provider's `MAIL_SES_*` / `MAIL_SENDGRID_*` variables and `MAIL_DOMAIN`) become the read-only "Environment" account and domain. `SMTP_FROM` / `SMTP_FROM_NAME` give core's streams their From; an address on another domain than the sending one becomes that domain's From domain. `MAIL_TRANSPORT` is `provider` (default), `smtp` (Mailpit; the default in development) or `log` (staging: nothing leaves the building, whatever accounts the database holds). Set `MAIL_WEBHOOK_SECRET` before ever rotating `NUXT_SECRET_ENCRYPTION_KEY`, or every webhook URL changes; rotating the key also strands queued outbox rows, so drain the outbox first.

### Moving a host from email-mailgun

Pin core to `^3` first if the host tracks `latest`, so the major arrives deliberately. Then:

1. `layers.ts`: swap `email-mailgun` for `mail`, raise core to `^4` and inbox to `^1`.
2. Runtime env: keep `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` (and `MAILGUN_HOST` in the EU) and `NUXT_SECRET_ENCRYPTION_KEY`; add `MAIL_WEBHOOK_SECRET`; remove `INBOX_DOMAIN`, `INBOX_CONTACT_ADDRESS` and `INBOX_MAILGUN_*`. Every value goes in the runtime environment, not the image build.
3. Deploy. The boot fails loudly if a provider is missing.
4. `/admin/email`: add the inbox domain for sending and receiving (manual setup, with its own sending key if the key is domain-scoped), assign it to the Inbox stream, copy the webhook URLs. A host whose inbox used a second Mailgun account adds that account first and puts the inbox domain on it. Until a domain can receive, inbox replies are held.
5. Mailgun dashboard: point the inbound route at the new `/inbound/mime` URL and the webhooks at the new events URL; remove the old `/api/inbox/webhooks/mailgun/*` targets.
6. Check: a password reset arrives, the receiving probe turns green, a test reply shows "Delivered".

Between steps 3 and 5 the old URLs answer 404. Mailgun retries a route forward that gets a 404, first after 10 minutes and then for about 8 hours, so inbound mail in the gap arrives once the route points at the new URL. Events posted in the gap (bounces, complaints, failures) are retried the same way; only delivered notifications may be lost.

### Releasing the mail kernel

Until `mail` has its first tag, core requires `@nuxtinator/mail >=0.0.0`: the build check still stops a host that fetched core without mail, and a host or the monorepo building from `master` passes with mail at `0.0.0`. Release in this order, each with `bun run release`:

1. mail → 1.0.0.
2. core → 4.0.0, raising its requirement to `@nuxtinator/mail >=1.0.0` in the release commit.
3. tenancy and crm → minor, inbox → 1.0.0, each raising its requirement to `@nuxtinator/core >=4.0.0`.
4. email-mailgun → 2.0.0, the empty layer.

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

Connection URLs: `DATABASE_URL` for `host_admin`, `APP_DATABASE_URL` for `app_user`. Single-tenant deploys need both too, since personal-app tables use RLS — see [database-roles.md](database-roles.md).

If you deploy through a connection pooler, configure transaction-pooling mode. `defineTenantHandler` uses `SET LOCAL`, which is transaction-scoped; session-pooling would leak `app.current_org` across requests. `prepare: false` is configured on the postgres-js driver to remain compatible with PgBouncer txn-pool.

### URL shape

In multi mode, app pages mount at `/@:orgSlug/<app>/...` via `pages:extend` aliasing. APIs always live at `/api/<app>/...`; the org slug travels in an `X-Active-Org` header that the tenancy layer builds into the global `$fetch` instance via its [fetch-template module](../layers/tenancy/modules/tenant-fetch-template.ts). MCP tools instead take an optional `org` slug input, falling back to the same header.

The tenancy layer's own pages live at `/@<slug>/settings/*` (org settings), `/orgs` (picker), `/orgs/new` (create org), `/admin/orgs` (host admin).

### Org-creation slug shape

Slugs match `^[a-z0-9-]{2,40}$`. With the `@` URL prefix, no slug can collide with any system route — the leading `@` is the disambiguator. No reserved-name list, no in-memory Set.
