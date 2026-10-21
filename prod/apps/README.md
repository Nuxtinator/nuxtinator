# Your own apps live here

This directory is for **app layers you write and own** — your project's
features (a calendar, a dashboard, a CRM…). Each subdirectory is loaded as a
Nuxt layer. Adding one is zero-config: drop the folder in and it loads.

That's wired in [`../nuxt.config.ts`](../nuxt.config.ts) — a small `localApps()`
helper globs `apps/*` into `extends`. (Nuxt only *auto*-discovers a directory
literally named `layers/`; we use `apps/` because in your project everything
here is an app, and glob it in ourselves.)

Contrast with `_layers/` (leading underscore): that holds the **upstream
nuxtinator layers** — `core`, `tenancy`, email backends, the bundled apps —
fetched by `bun run sync-layers` from the URLs in [`../layers.ts`](../layers.ts).
It's gitignored and regenerated; never edit it.

| Directory | Holds | Source | Committed? |
|---|---|---|---|
| `apps/<id>/` | app layers **you** write | you — globbed into `extends` | yes |
| `_layers/<id>/` | layers **fetched** from a repo | `../layers.ts` → `sync-layers` | no (gitignored) |

## Start a new app: copy `example/`

[`example/`](example/) is a complete, minimal app layer. To make your own:

```bash
cp -r apps/example apps/reports      # pick your app id
```

Then **rename every `example` → `reports`** (the app id is a prefix on
everything — paths, permissions, table names, registry ids):

- `package.json` → `"name": "@my-app/reports"`
- `app/utils/permissions.ts` → `reports.access` / `reports.read` / `reports.write`, `REPORTS_*` consts
- `server/plugins/register-example.ts` → rename file to `register-reports.ts`; update `registerApp({ id: 'reports', path: '/reports', … })`, `registerNavItem`, `registerDefaultGrants('reports', …)`
- `app/pages/example/` → `app/pages/reports/`
- `server/routes/api/example/` → `server/routes/api/reports/`

Restart `bun run dev`. The launcher shows a **Reports** tile to anyone with
`reports.access` (admins see everything). `GET /api/reports` returns `true`.

## What's in the example

| File | Purpose |
|---|---|
| `package.json` | Layer manifest. Framework/DB singletons (`nuxt`, `vue`, `kysely`, …) go in `peerDependencies` so they resolve to the host's copy; cross-layer deps like `@nuxtinator/core` go in `optionalDependencies` as `"*"`. No `main` field. |
| `nuxt.config.ts` | `defineNuxtConfig({})` — the layer's config entrypoint. |
| `app/utils/permissions.ts` | Declares permissions, meta, default grants, and widens `#permissions` for TypeScript. |
| `server/plugins/register-example.ts` | Nitro plugin that feeds core's registries at boot — launcher tile, nav item, permissions, default grants. This is what makes the feature first-class instead of just a reachable URL. |
| `server/routes/api/example/index.get.ts` | A `defineTenantHandler` endpoint (auth-gated) returning `true`. |
| `app/pages/example/index.vue` | The page. Write paths single-tenant-shape (`/example`); the tenancy layer adds `/@:slug/example` aliases automatically when loaded. |

## Conventions

Prefix **everything** with your app id — UI routes, API routes, DB tables,
migration filenames, permissions, components, composables. Two apps that
collide on a path or table name break the model. Permission strings use `.`
(`reports.read`), DB tables use `_` (`reports_items`).

## Going further

Adding DB tables, per-org tenancy retrofits (`*_T<NNN>_*.ts` migrations),
admin sections, or static roles? The full file-by-file guide is upstream:
https://github.com/Nuxtinator/nuxtinator/blob/master/documentation/layers.md
(section "Creating a new app layer"). Everything there applies; the only
difference is your app loads from `apps/` instead of being fetched.
