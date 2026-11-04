# CLAUDE.md

Guidance for Claude Code (and humans) working in **this project** — a Nuxtinator host.

This is a thin **host shell**. Almost all functionality — auth, admin, RBAC, multi-tenancy, email, OAuth, MCP, bundled apps — lives in **layers** fetched from the nuxtinator repo into `_layers/<id>/` at setup time. You own this host; you don't own the layer source. To change a feature you configure or extend a layer — you don't edit `_layers/` (it's regenerated on every `sync-layers`).

> Scaffolding a *new* project from nuxtinator, or changing which layers this one uses? That's a different task — see the nuxtinator repo's README "Assembly instructions". This file is for working **inside an already-scaffolded host**.

## Layer selection: edit `layers.ts`, never `extends:`

[layers.ts](layers.ts) is the single source of truth for which layers this project loads. Both `nuxt.config.ts` (the `extends:` array) and `scripts/sync-layers.ts` (the fetcher) derive from it.

- **Add/remove a layer** → edit the `LAYERS` array in `layers.ts`, then run `bun run setup` to fetch it.
- **Never edit the `extends:` array** in `nuxt.config.ts` directly — it's computed from `LAYERS`. Editing it creates drift between what's fetched and what's loaded.
- Load order matters: `core` first, `tenancy` second (its multi-mode kernel overrides core's single-mode), email backend, `oauth`, `mcp`, app layers, `dev` last.

## Commands (run from the project root)

```bash
bun run setup     # full bootstrap: install → fetch layers (sync-layers) → install. Idempotent.
bun run dev       # dev server on http://localhost:2080
bun run build     # production build
bun run lint
bun run typecheck
```

`_layers/` is a build artifact — gitignored, re-fetched by `sync-layers`. Don't commit it; don't edit files inside it (changes are lost on the next setup). On a fresh clone, `_layers/` is absent until you run `bun run setup`.

## Layer versions & updates

Each entry in [layers.ts](layers.ts) carries a `version` policy (default `'latest'` = auto-update to the newest release; omit it for that). Set it per layer to control how updates flow:

- `'^1.4.0'` — take minor + patch automatically, **hold majors**
- `'~1.4.0'` — patch only
- `'1.4.0'` — exact pin
- `'master'` / a branch / a SHA — track a raw ref (bleeding edge)

`version` is resolved to a concrete git tag and recorded in **`layers.lock.json`** (committed — it's what makes a deploy reproducible and busts the build cache). `sync-layers` fetches exactly what the lock pins; it does not re-resolve ranges on every build.

```bash
bun run layers:check    # dry run — what newer versions are available in range
bun run layers:update   # advance layers.lock.json to the newest in-range versions
```

A scheduled GitHub Action ([.github/workflows/layer-updates.yml](.github/workflows/layer-updates.yml)) runs `layers:update` weekly and opens a PR with the lockfile change — merge it to deploy the update. It works with no secrets on public sources; add a `LAYER_UPDATE_TOKEN` (fine-grained PAT) so the PR runs CI and can auto-merge, and a `LAYER_SOURCE_TOKEN` (read-only) for a private layer source. Major updates outside a layer's range are reported, not auto-applied — widen the range in `layers.ts` to adopt one.

Resolution also honours each layer's `nuxtinator.requires` (minimum versions of other layers, in its `package.json`): a layer whose newest release needs more than the others resolve to is held at an older release and listed under "Held back by layer requirements". When no compatible set exists, `layers:update` writes nothing and exits non-zero, so the weekly Action fails instead of opening a PR. The build checks the same requirements and stops on an unmet one between fetched layers.

## Cross-layer imports (aliases)

Import shared functionality by alias, not relative path into `_layers/`:

| Symbol | Import from |
|---|---|
| Core server utils | `#core/server/utils/<name>` (e.g. `db` from `#core/server/utils/database`) |
| Core client utils | `#core/app/utils/<name>` |
| Core schema types | `#core/server/database/schema` |
| Tenant context (server) | `#tenant/server` (`defineTenantHandler`, `requireOperatorAdmin`, …) |
| Tenant composables (client) | `#tenant` (`useActiveOrg`, `useTenantFetch`, …) |
| Email | `#email` (`sendTemplateEmail`) — throws a clear error if no email layer is loaded |
| Permission keys | `#permissions` |

Core composables/components are auto-imported (no explicit import needed).

## Where your code goes — host vs. your own app

You add features two ways. Pick by reuse, not by size:

- **In the host** (this project) — for code only *this* project needs. Lives directly in `app/`, `server/`, `migrations/`. Nothing to fetch. This is the common case.
- **In your own app layer** (`apps/<id>/`) — for a self-contained feature you'd reuse or version on its own. `nuxt.config.ts` globs `apps/*` into `extends`; copy the ready-made [apps/example/](apps/example/) to start. See [Creating your own app](#creating-your-own-app) below.

Either way: never put your code in `_layers/` — that's regenerated on every `sync-layers` and your edits are lost.

### Adding a feature in the host

```
app/pages/<feature>/...                  ← pages (route by URL)
server/routes/api/<feature>/...          ← API routes (NOT server/api/)
server/plugins/register-<feature>.ts     ← wires the feature into the app shell (see below)
migrations/<feature>_NNN_<desc>.ts       ← runs alongside every layer's on boot
```

- **Write pages in single-tenant shape** — no `/@:orgSlug/...` prefix. If the `tenancy` layer is loaded it adds the `/@:slug/...` aliases automatically; don't hand-write them.
- Server routes that need a user / permissions use `defineTenantHandler` from `#tenant/server` (single mode = `requireAuth` + a transaction; multi mode adds org context). Database access is `db` from `#core/server/utils/database`.
- **Migration filenames must be globally unique** across the host + every layer. Prefix with your feature id: `reports_001_*.ts`.

A bare page gives you a reachable URL but **no launcher tile, no sidebar nav, no permission gating**. To make a feature first-class, add a Nitro plugin that feeds core's registries (the same mechanism every layer uses — import them by the `#core` alias):

```ts
// server/plugins/register-reports.ts
import { registerPermissions }   from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp }           from '#core/server/utils/app-registry'
import { registerNavItem }       from '#core/server/utils/nav-registry'

export default defineNitroPlugin(() => {
  registerPermissions(['reports.access', 'reports.read'], {
    'reports.access': { title: 'Access Reports', description: 'Open the Reports app.' },
    'reports.read':   { title: 'Read reports',   description: 'View reports.' }
  })
  registerDefaultGrants('reports', {
    admin:  ['reports.access', 'reports.read'],
    member: ['reports.access', 'reports.read']
  })
  registerApp({                       // launcher tile
    id: 'reports', title: 'Reports', path: '/reports',
    icon: 'i-lucide-bar-chart', requiredPermission: 'reports.access', order: 40
  })
  registerNavItem({                   // in-app sidebar item
    appId: 'reports', title: 'All reports', path: '/reports',
    icon: 'i-lucide-list', requiredPermission: 'reports.read', order: 10
  })
})
```

To make TypeScript accept your new permission strings, widen the `#permissions` interface anywhere in the host (e.g. `app/utils/permissions.ts`):

```ts
declare module '#permissions' {
  interface PermissionRegistry { 'reports.access': true; 'reports.read': true }
}
```

The six registries you can feed (all under `#core/server/utils/`): `app-registry` (launcher tiles), `nav-registry` (in-app nav), `admin-section-registry` (admin shell sections), `permissions-registry`, `default-grants-registry` (role→permission defaults), `roles-registry` (shippable static roles). **Prefix everything with your feature id** — paths, tables, migrations, permissions, components — or you'll collide with a layer.

## Creating your own app

An app layer is a self-contained feature (pages + routes + permissions + migrations) you can drop in or lift out as a unit. There are two homes, depending on whether you want to share it:

### Local — `apps/<id>/` (the common case)

`nuxt.config.ts` globs `apps/*` into `extends`, so every subdirectory loads as a layer. No `layers.ts` entry, no fetch, no install — drop the folder in and it loads.

```bash
cp -r apps/example apps/reports     # then rename example → reports everywhere
```

[apps/example/](apps/example/) is a complete minimal app layer (page + `true` endpoint + registry wiring); [apps/README.md](apps/README.md) lists every file and the rename steps. `apps/` is committed and owned by you; `_layers/` is the gitignored cache of fetched layers — don't confuse them.

### Remote — published to a repo, listed in `layers.ts`

To share a layer across projects, put it in its own git repo and add an entry to [layers.ts](layers.ts):

```ts
{ id: 'reports', pkg: '@yourscope/reports', url: 'github:your-org/reports#v1.0.0' }
```

`bun run setup` fetches it into `_layers/reports/` and Nuxt extends it by package name. giget supports `github:` / `gitlab:` / `bitbucket:` / `sourcehut:` / `https://…tarball` — **there is no `file:` provider**, so for a local app use `apps/<id>/` (above), not a `file:` URL.

### Layer package.json rules (either home)

Framework/DB singletons (`nuxt`, `vue`, `@nuxt/kit`, `@nuxt/ui`, `kysely`, `kysely-postgres-js`, `postgres`, `h3`, `tailwindcss`) go in `peerDependencies` so they resolve to this host's copy. Layer-private deps go in `dependencies`. Cross-layer deps (e.g. `@nuxtinator/core`) go in `optionalDependencies` as `"*"`. Don't add a `main` field.

For the full file-by-file template — DB schema augmentation, per-app tenancy retrofit migrations (`*_T<NNN>_*.ts`), admin sections, static roles, and the prefix conventions — see the upstream guide: **https://github.com/Nuxtinator/nuxtinator/blob/master/documentation/layers.md** (section "Creating a new app layer").

## UI rules

Before any UI work — in the host or in your own app layer — read `_layers/core/DESIGN.md` and follow it. It lists the core components to use (help icons, sidebars, settings rows, confirm dialogs) and the styling rules every nuxtinator page shares. It updates with core, so re-read it after a core update.

## Good to know

- **SSR is off** — this is a SPA.
- **Auth is JWT.** The **first user to register is auto-promoted to operator-admin.**
- **Updating nuxtinator:** set each layer's `version` in `layers.ts` and run `bun run layers:update` (see "Layer versions & updates"). To pin *every* layer to one ref at once, set `NUXTINATOR_REF=<tag-or-sha>` in `.env` — it overrides resolution for all layers.
- **Per-layer local override:** `NUXTINATOR_<ID>_PATH=../sibling-checkout` in `.env` points one layer at a working copy without touching `layers.ts`.

## Don't

- Don't edit `extends:` in `nuxt.config.ts` — edit `layers.ts`.
- Don't commit or edit `_layers/` — it's regenerated by `sync-layers`.
- Don't add `@nuxtinator/*` to `package.json` `dependencies` — layers arrive as `_layers/*` workspace members, not npm deps.
- Don't change the `workspaces` glob from `_layers/*` to `.layers/*` — bun won't match dot-dirs and silently links nothing.
- Don't delete `bunfig.toml` or switch `linker = "hoisted"` to `"isolated"` — Nuxt can't resolve `@nuxtinator/<id>` by name without the hoisted symlinks.
