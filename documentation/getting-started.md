# Getting started — start a new project that consumes nuxtinator layers

This guide is for **downstream consumers**: you want a fresh project that uses [nuxtinator](https://github.com/Nuxtinator/nuxtinator)'s layers (auth, admin, multi-tenancy, OAuth, MCP, the bundled apps), without forking the layers themselves.

You'll end up with a tiny project that has a `layers.ts` file listing which layers you want. A sync script fetches each one from GitHub into `_layers/<id>/`, bun workspaces hoist their deps into a single `node_modules/`, and Nuxt's `extends:` resolves each by package name. You own the project; you can update the pinned ref whenever you want a newer cut of the layers.

If instead you want to work on the layers themselves, see [dev-setup.md](dev-setup.md).

---

## TL;DR

```bash
# 1. Pull the prod template from the nuxtinator repo into a new project
#    (#master is required — giget defaults to main, but this repo uses master)
bunx giget github:Nuxtinator/nuxtinator/prod#master my-app
cd my-app

# 2. Pick which layers you want (the only file you edit for layer selection)
$EDITOR layers.ts             # delete entries for layers you don't need

# 3. Configure environment
cp .env.example .env          # then fill in DATABASE_URL, JWT_SECRET, etc.

# 4. Three-phase bootstrap (install root deps → fetch layers → reinstall to hoist)
bun run setup

# 5. Run
bun run dev                   # http://localhost:2080
```

That's it.

---

## What you got

After Step 1 you'll see:

```
my-app/
├── layers.ts                 ← single source of truth for REMOTE layer selection
├── nuxt.config.ts            ← imports LAYERS; derives extends: (and globs apps/*)
├── scripts/sync-layers.ts    ← iterates LAYERS; downloadTemplate per URL → _layers/<id>/
├── apps/                     ← YOUR OWN app layers (globbed into extends)
│   ├── README.md             ← how to add one
│   └── example/              ← a ready-made minimal app — copy it to start
├── package.json              ← workspaces: ["_layers/*"]; no @nuxtinator/* deps
├── bunfig.toml               ← [install] linker = "hoisted" (required — don't delete)
├── .env.example
├── .gitignore                ← already ignores _layers, node_modules, .nuxt, .output, .env
├── tsconfig.json
├── eslint.config.mjs
└── public/favicon.ico
```

Initialize git if you want this to be your own project's repo:

```bash
git init && git add . && git commit -m "scaffold from nuxtinator"
```

---

## Step 1: choose your layers (edit `layers.ts`)

Open `layers.ts`. It has an entry for every available nuxtinator layer:

```ts
const REF = process.env.NUXTINATOR_REF || 'master'

export const LAYERS = [
  { id: 'core',           pkg: '@nuxtinator/core',           url: `github:Nuxtinator/nuxtinator/layers/core#${REF}` },
  { id: 'tenancy',        pkg: '@nuxtinator/tenancy',        url: `github:Nuxtinator/nuxtinator/layers/tenancy#${REF}` },
  { id: 'email-mailgun',  pkg: '@nuxtinator/email-mailgun',  url: `github:Nuxtinator/nuxtinator/layers/email-mailgun#${REF}` },
  // ...one entry per layer...
  { id: 'dev',            pkg: '@nuxtinator/dev',            url: `github:Nuxtinator/nuxtinator/layers/dev#${REF}` }
] as const
```

**Delete the entries for layers you don't want.** Keep load order intact: `core` first; `tenancy` second (its multi-mode kernel overrides core's single-mode); email backend; `oauth`; `mcp`; app layers; `dev` last.

Rules of thumb:

- **`core` is mandatory.** It owns the registries, auth, admin shell, and the single-mode `#tenant` kernel.
- **`tenancy` is the big switch.** With it: orgs, memberships, RLS, two DB roles, `/@:slug/...` URLs. Without it: single-tenant, one DB role, plain URLs. App layers work the same in both modes — see [layers.md](layers.md#the-tenant-kernel).
- **Email backends are pluggable.** Currently shipped: `email-mailgun`. Pick zero or one. With none loaded, code that imports `#email` throws helpfully on first call (so unused features stay quiet, but auth flows that send mail will fail loudly).
- **App layers are à la carte.** Keep what you want, delete what you don't. Each is self-contained.
- **Drop `dev` for production builds** — it adds the `/kitchen` sandbox.

**You don't need to touch `nuxt.config.ts` or `scripts/sync-layers.ts`.** Both import `LAYERS` from `layers.ts` and derive what they need.

---

## Step 2: configure environment

```bash
cp .env.example .env
```

Then edit `.env`. Minimum required to boot:

```bash
APP_TITLE="My App"
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
JWT_SECRET=<run: openssl rand -base64 32>
NUXT_PUBLIC_SITE_URL=http://localhost:2080
NUXT_SECRET_ENCRYPTION_KEY=<run: openssl rand -hex 32>   # exactly 64 hex chars
```

Add more depending on which layers you enabled:

| Layer | Extra env |
|---|---|
| `tenancy` | `NUXT_TENANT_FLOW_SECRET` (`APP_DATABASE_URL`, the `app_user` role, is needed by every deploy — see [database-roles.md](database-roles.md)) |
| `email-mailgun` | `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `SMTP_FROM`, `SMTP_FROM_NAME` |
| `oauth` | `OAUTH_CONSENT_COOKIE_SECRET` |
| `feedback` | `NUXT_PUBLIC_FEEDBACK_PROJECT_ID` |
| Anything that uploads (videos, attachments) | `S3_*` vars |

The full list is in `.env.example`.

**Production pin** — `.env` also accepts a commented `NUXTINATOR_REF=<tag-or-sha>` line. Set it to a tag like `v1.0.0` for reproducibility (the default `master` will drift each time you run `bun run sync-layers`).

---

## Step 3: provision the database

Postgres is required. Migrations run automatically on first boot — you just need a role and a database to connect to.

**Single-tenant** (no `tenancy` layer in `layers.ts`):

```sql
CREATE ROLE myapp LOGIN PASSWORD '<...>';
CREATE DATABASE myapp OWNER myapp;
GRANT ALL PRIVILEGES ON SCHEMA public TO myapp;
```

Set `DATABASE_URL=postgres://myapp:<...>@localhost:5432/myapp`. Done.

**Multi-tenant** (with `tenancy` in `layers.ts`):

You need two roles — `host_admin` (BYPASSRLS, used for migrations and cross-org admin) and `app_user` (RLS-enforced, the runtime default). And if you put a connection pooler in front, it must be transaction-pooling, not session-pooling. Full setup in [tenancy.md](tenancy.md).

---

## Step 4: bootstrap and run

```bash
bun run setup
bun run dev
```

`bun run setup` chains three commands:

1. **`bun install`** — installs the project's root deps (nuxt + framework peers + giget). The `_layers/*` workspaces glob doesn't match yet (the directory doesn't exist), so no layers are linked.
2. **`bun run sync-layers`** — iterates `LAYERS` in `layers.ts`, calls `giget` for each, extracts the layer's source into `_layers/<id>/`.
3. **`bun install`** (again) — now the workspaces glob matches `_layers/*`. Bun reads each layer's `package.json`, hoists deps into root `node_modules/`, and symlinks each layer as `node_modules/@nuxtinator/<id>/`.

First `bun run dev` creates the schema (you'll see migration logs). Then visit <http://localhost:2080> and register an account. The first user to register is automatically promoted to operator-admin.

---

## Adding your own app layer

You don't need to fork the nuxtinator repo to add features. Three ways, by how reusable the feature is:

1. **In-project code** — drop pages under `app/pages/<your-app>/` and routes under `server/routes/api/<your-app>/` directly in your project. Anything you `import` resolves against the project's deps. Good for project-specific stuff that won't be reused.

2. **A local app in `apps/<id>/`** — for a self-contained feature you'd lift in or out as a unit. `nuxt.config.ts` globs `apps/*` into `extends`, so every subdirectory loads as a layer — no `layers.ts` entry, no fetch, no install step. The template ships a ready-made [`apps/example/`](https://github.com/Nuxtinator/nuxtinator/tree/master/prod/apps/example); copy it and rename `example` → your app id throughout. This is the recommended home for your own apps. (Don't confuse `apps/` — your committed source — with `_layers/`, the gitignored cache of fetched layers.)

3. **A shared layer in its own repo** — to reuse a layer across projects, publish it to a git host and add an entry to `layers.ts`:

   ```ts
   { id: 'my-layer', pkg: '@yourscope/my-layer', url: 'github:your-org/my-layer#v1.0.0' }
   ```

   `bun run setup` fetches it into `_layers/my-layer/`. giget accepts `github:` / `gitlab:` / `bitbucket:` / `sourcehut:` sources — there is **no `file:` provider**, so for a local app use option 2 (`apps/<id>/`), not a `file:` URL. To iterate on a *fetched* layer against a local checkout, use the `NUXTINATOR_<ID>_PATH` env override (see "Working against local layer source" below).

See [layers.md](layers.md#creating-a-new-app-layer) for the full layer template (permissions, registries, migrations, tenancy retrofits).

Adding to your own project never touches nuxtinator's code. `bun run setup` re-fetches and rehoists; apps in `apps/` need no setup at all.

---

## Updating to a newer cut of nuxtinator

Set `NUXTINATOR_REF=<new-tag-or-sha>` in `.env`, then re-run `bun run setup`. `forceClean: true` in `sync-layers.ts` means each layer is re-extracted from the new ref. Migrations included in the newer cuts will run on next boot.

Read the upstream changelog before bumping — schema migrations may not be reversible.

For per-layer ref pinning (e.g. you want `core@v1.0.0` but `messages@master` for some reason), edit the URL fields in `layers.ts` directly:

```ts
{ id: 'core',     pkg: '@nuxtinator/core',     url: 'github:Nuxtinator/nuxtinator/layers/core#v1.0.0' },
{ id: 'messages', pkg: '@nuxtinator/messages', url: 'github:Nuxtinator/nuxtinator/layers/apps/messages#master' }
```

The shared `REF` constant at the top of `layers.ts` is just a convenience for keeping most layers in sync.

---

## Working against local layer source (optional)

Two ways to point a single layer at a sibling checkout without changing committed config:

**Option A — env var**, set in `.env`:

```bash
NUXTINATOR_MESSAGES_PATH=../../scratch/messages-experiment
```

Format: `NUXTINATOR_<ID>_PATH` (id uppercased, hyphens/slashes become underscores). The `layer()` helper in `nuxt.config.ts` reads it and returns the path instead of the package name. Only the named layer is overridden; the rest still resolve through `_layers/<id>/`.

**Option B — `bun link`** (no env, lasts until next `bun install`):

```bash
# In the sibling repo:
cd ~/code/messages-experiment && bun link

# In your project:
cd ~/code/my-app && bun link @nuxtinator/messages
```

To revert: remove the env var or run `bun install` again.

---

## Production deploy

Your project deploys standalone. `_layers/` is fetched at build time, layer deps hoist via workspaces, output goes to `.output/`.

```bash
bun run setup            # fetches layers + hoists deps
bun run build            # standard Nuxt build
```

The output under `.output/` runs anywhere Nuxt runs (Node, Bun, Docker, your platform of choice). Set `NODE_ENV=production` and the same env vars you used in dev (with production values).

Pin `NUXTINATOR_REF` in production — `master` will drift. CI should fail loudly if `NUXTINATOR_REF` isn't set.

For multi-tenant production specifics — the two-role split, transaction-pooling — see [tenancy.md](tenancy.md). For single-tenant, see [single-tenant-deploy.md](single-tenant-deploy.md).

---

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `nuxt prepare` errors with `Cannot find module '@nuxtinator/<x>'` | `bunfig.toml linker = "hoisted"` is missing or set to `"isolated"` | Restore `bunfig.toml` to `[install]\nlinker = "hoisted"`. Bun 1.3+ defaults to isolated, which doesn't create the top-level workspace symlinks Nuxt needs. |
| `bun install` succeeds but no `node_modules/@nuxtinator/*` symlinks appear | `workspaces` glob is wrong — probably `.layers/*` (dot-prefixed) instead of `_layers/*` | Bun's minimatch defaults to `dot: false` and silently skips dot-prefixed dirs. Use `_layers/*` in `package.json`. |
| `Workspace dependency "@nuxtinator/core" not found` during `sync-layers`'s install | A layer's `package.json` lists `workspace:*` deps and bun ran install standalone | Should be a non-issue under the current recipe (workspaces hoist resolves these). If you see it, you may have run `bun install` inside a `_layers/<id>/` directory directly — don't; run it from the project root. |
| Hangs on a page route that worked yesterday | Layer added a new migration that failed | Check the boot logs — failed migrations halt boot. Fix the DB state, restart. |
| New layer added to `layers.ts` doesn't show up | Forgot to re-run `bun run setup` after editing | Edit `layers.ts` → `bun run setup` re-fetches and rehoists. |

---

## See also

- [layers.md](layers.md) — what each layer owns, how to write your own, the `#tenant` kernel contract
- [dev-setup.md](dev-setup.md) — for working on nuxtinator itself (the monorepo) rather than consuming it
- [single-tenant-deploy.md](single-tenant-deploy.md) — single-tenant specifics
- [tenancy.md](tenancy.md) — multi-tenant specifics: roles, RLS, pooling
- The root [README.md](../README.md) — covers the same flow with shorter Assembly Instructions written for an AI agent
