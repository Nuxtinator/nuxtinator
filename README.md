# Nuxtinator

A layer-based foundation for Nuxt SaaS apps. You ship a tiny **host** (config + branding + project-specific pages); everything else — auth, admin, multi-tenancy, OAuth, MCP, bundled apps — lives in versioned **layers** that your host's `package.json` pulls from this repo at install time.

You own the host. You don't fork the layers. To get a newer cut of a feature, bump a ref.

## Getting Started

Nuxtinator projects are assembled by Claude Code. You tell it which layers you want; it scaffolds the host, edits `nuxt.config.ts` to extend just those layers, generates `.env.example` with only the vars those layers need, and verifies the project boots.

### 1. Create an empty directory

```bash
mkdir my-app && cd my-app
```

You don't need to scaffold a Nuxt project yourself — Claude pulls the host from this repo.

### 2. Open Claude Code in that directory

```bash
claude
```

### 3. Tell Claude to build from nuxtinator

Point it at this repo and describe what you want:

```
Read https://raw.githubusercontent.com/Nuxtinator/nuxtinator/master/README.md and follow its assembly instructions to scaffold a new Nuxt app.
```

Optionally include which layers you want:
```
I want multi-tenant orgs, Mailgun email, OAuth + MCP,
and the calendar and kanban apps.
```

Claude will read this README, resolve dependencies, **confirm the layer list with you**, then scaffold by following the assembly instructions at the bottom of this file.

### 4. Configure and run

Once Claude finishes, fill in your `.env` and start the dev server:

```bash
cp .env.example .env   # then fill in real values (DATABASE_URL, JWT_SECRET, …)
bun run setup          # install deps + fetch layers into _layers/ (idempotent; safe to re-run)
bun run dev
```

Dev server: <http://localhost:2080>.

---

## Available layers

| Layer | Type | Description | Docs |
|---|---|---|---|
| [core](layers/core/) | Always | Auth, admin shell, RBAC, registries, single-mode `#tenant` kernel, migrations runner, launcher chrome. Never optional. | [layers.md](documentation/layers.md) |
| [tenancy](layers/tenancy/) | Optional | Multi-tenant orgs + memberships + RLS. Adds `/@:slug/...` URL aliases and the multi-mode `#tenant` kernel. Omit for single-tenant. | [tenancy.md](documentation/tenancy.md) |
| [email-mailgun](layers/email-mailgun/) | Choice | Mailgun (HTTP API in prod, MailHog locally). Provides `#email`. | — |
| [social-auth](layers/social-auth/) | Optional | Sign in with Google and Sign in with Apple, for the web app and native apps. | [README](layers/social-auth/README.md) |
| [oauth](layers/oauth/) | Optional | OAuth 2.1 issuer (token, consent, admin endpoints). | — |
| [mcp](layers/mcp/) | Optional | MCP server transport. Depends on `oauth`. | — |
| [apps/messages](layers/apps/messages/) | Optional | Team messaging app (channels, DMs, comments, reactions). | — |
| [apps/videos](layers/apps/videos/) | Optional | Video recording + playback app. | — |
| [dev](layers/dev/) | Optional | UI sandbox at `/kitchen`. Useful in dev, comment out for prod. | — |

### Layer types

- **Always** — included in every project (`core`).
- **Choice** — pick at most one from a group. Currently the only choice group is **email backend** (`email-mailgun`; `email-smtp` and `email-ses` are planned). Skip the group entirely if your app doesn't send mail — code that imports `#email` will throw a clear error if no backend is loaded.
- **Optional** — included only if you ask for it.

Dependencies are resolved automatically: asking for `mcp` pulls in `oauth`.

---

## How layers actually load

Two artifacts, two mechanisms.

**This monorepo (maintainer side).** Layers live at `layers/<id>/` and `layers/apps/<id>/`. [dev/package.json](dev/package.json) lists each as `"@nuxtinator/<id>": "workspace:*"`; [dev/nuxt.config.ts](dev/nuxt.config.ts) extends by package name. Bun's workspace symlinks make each name resolve through `node_modules/@nuxtinator/<id>/` to the local source. One repo, one install, one resolution path.

**A consumer project (what the AI scaffolds).** The [prod/](prod/) folder in this repo is the **starter template** — it ships the consumer recipe fully wired up. The user-facing file is **`layers.ts`** at the root: a single `LAYERS` array of `{ id, pkg, url }` entries, one per available layer. Both `nuxt.config.ts` (the `extends:` array) and `scripts/sync-layers.ts` (the fetcher) import `LAYERS` from it. To pick what your project uses, edit `layers.ts`. Nothing else in the template needs editing for layer selection. The rest of the template (`package.json` with `workspaces: ["_layers/*"]` + no `@nuxtinator/*` deps, `bunfig.toml linker = "hoisted"`, `nuxt.config.ts` with the `layer()` helper and `stripLayerTsconfigs` hook, `.env.example` with the env superset) is infrastructure that stays untouched.

At runtime, each layer fetched by `sync-layers` lands in `_layers/<id>/`; on `bun install`, bun reads those as workspace members, hoists their deps into the root `node_modules/`, and symlinks each into `node_modules/@nuxtinator/<id>/` where Nuxt's `extends:` resolves them by package name. Layer source is visible at `_layers/<id>/` for inspection, debugging, or grep.

Net: one `node_modules/` at the root, no per-layer install, no per-layer duplication of the framework peer tree. Each layer's `package.json` remains the source of truth for its deps — the consumer's `package.json` never lists them, and a layer's dep changes flow through on the next `sync-layers && bun install` automatically.

Bootstrap is three commands wrapped as `bun run setup`:

1. `bun install` — installs the consumer's root deps including `giget`. The `_layers/*` workspaces glob doesn't match yet (the directory doesn't exist).
2. `bun run sync-layers` — calls `giget` for each selected layer; extracts `github:Nuxtinator/nuxtinator/layers/<id>#<ref>` into `_layers/<id>/`.
3. `bun install` (second pass) — bun re-evaluates the workspaces glob, now finds `_layers/<id>/` directories, hoists their deps into the root `node_modules/.bun/` store, and creates `node_modules/@nuxtinator/<id>/` symlinks.

Day-to-day is just `bun run dev`. Updating: `NUXTINATOR_REF=<tag>` in `.env`, then `bun run setup` again (the layer dirs get force-cleaned and refetched).

A `layer()` helper in the consumer's `nuxt.config.ts` honors a per-layer env override: set `NUXTINATOR_<ID>_PATH=../../my-checkout` to point an individual layer at a sibling checkout during development (id uppercased, hyphens become underscores). Without an override, the package-name extends through the workspace symlink.

> **Important: the layer directory must be named `_layers/`, not `.layers/`.** Bun's workspaces glob follows minimatch's default `dot: false` and silently won't match dot-prefixed directories. `"workspaces": [".layers/*"]` makes `bun install` succeed but never create the workspace symlinks — no error message, nothing works. The `_layers/` name (or any non-dot name) is required.

See [documentation/getting-started.md](documentation/getting-started.md) for the full setup guide.

---

## Environment variables at a glance

Each layer has its own env-var requirements. Claude generates a `.env.example` containing only the ones for the layers you picked. The full superset:

### Core (required)

```env
APP_TITLE="My App"
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
JWT_SECRET=<openssl rand -base64 32>
NUXT_SECRET_ENCRYPTION_KEY=<openssl rand -hex 32>   # exactly 64 hex chars
NUXT_PUBLIC_SITE_URL=http://localhost:2080
NODE_ENV=development
```

**Database TLS** auto-negotiates by default — postgres.js `prefer`: it asks the server (via `SSLRequest`) and uses TLS when the server offers it, falling back to plaintext when it doesn't. So a local Postgres with no TLS, a private-network Postgres/PgBouncer that speaks plaintext (Docker, Dokploy, Fly internal networking), and a managed Postgres that requires TLS all connect with no configuration. To force a specific posture, append `?sslmode=...` to `DATABASE_URL`/`APP_DATABASE_URL` — the standard libpq modes (`disable`, `allow`, `prefer`, `require`, `verify-full`) are honored. Note that `prefer` and `require` do **not** verify the server certificate; use `verify-full` (with a CA the cert chains to) for real MITM protection.

### Tenancy (multi-tenant only)

```env
APP_DATABASE_URL=postgres://app_user:...@.../db   # falls back to DATABASE_URL if unset
```

Multi-tenant production also requires a transaction-pooling connection pooler. See [tenancy.md](documentation/tenancy.md).

### Email (Mailgun)

```env
MAILGUN_API_KEY=
MAILGUN_DOMAIN=
MAILGUN_HOST=                     # only for EU region: api.eu.mailgun.net
SMTP_FROM=noreply@yourdomain.com
SMTP_FROM_NAME="My App"
```

### OAuth

```env
OAUTH_CONSENT_COOKIE_SECRET=<openssl rand -base64 32>
OAUTH_ALLOW_DCR=true
```

### MCP

```env
MCP_SERVER_NAME="My App"
MCP_SERVER_VERSION=1.0.0
```

### S3 (anything that uploads — videos, attachments)

```env
S3_ENDPOINT=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=
S3_PUBLIC_BUCKET_NAME=            # optional public-read bucket; falls back to S3_BUCKET_NAME
S3_PUBLIC_BASE_URL=               # public read URL (custom domain on the public bucket); for public files
```

---

## Documentation

- [documentation/getting-started.md](documentation/getting-started.md) — manual setup walkthrough (if you'd rather not use Claude)
- [documentation/layers.md](documentation/layers.md) — what each layer owns, the `#tenant` kernel contract, how to write your own layer
- [documentation/single-tenant-deploy.md](documentation/single-tenant-deploy.md) — deploying without `tenancy`
- [documentation/deploy-behind-a-proxy.md](documentation/deploy-behind-a-proxy.md) — `NUXT_TRUSTED_PROXIES`: which proxies may speak for the client IP (Cloudflare, PaaS)
- [documentation/tenancy.md](documentation/tenancy.md) — multi-tenant: roles, RLS, transaction-pooling
- [documentation/dev-setup.md](documentation/dev-setup.md) — for working on this monorepo itself

---
---

## Assembly instructions (for the AI scaffolding a new project)

> **This section is read by Claude Code when a user asks it to "build from nuxtinator".** If you're a human reader, skip it — the manual walkthrough is in [getting-started.md](documentation/getting-started.md).

> **Read this before you do anything else.** Confirmation is non-negotiable, even in auto / headless / agent-orchestrated mode. Step 3 below presents the resolved layer list and waits for the user; **you do not skip it**, you do not pick "a sensible default" because the user didn't specify, you do not scaffold first and let them "redirect later." The layer set IS the decision the user is making by invoking you — guessing it is wasted work for both of you (reverting a wrong scaffold is more work than asking up front). If you genuinely have no way to receive a reply, **halt** and surface the missing-input to whoever orchestrates you. Do not write any file until the layer list is confirmed.

When a user asks to build from this repo, follow these steps in order.

### Step 1: Parse the user's request

Read the **Available layers** table above. Map casual language to layer names:

- "auth" / "login" / "users" → already in `core` (no separate layer)
- "multi-tenant" / "orgs" / "organizations" / "workspaces" / "teams" → `tenancy`
- "single-tenant" / "no orgs" / "just one team" → omit `tenancy`
- "Mailgun" / "email" (default backend) → `email-mailgun`
- "no email" / "skip email" → omit any email layer
- "Sign in with Google" / "Sign in with Apple" / "social login" → `social-auth`
- "OAuth" / "OAuth server" / "issue tokens" → `oauth`
- "MCP" / "Model Context Protocol" → `mcp` (and `oauth`, automatically)
- "calendar" → `apps/calendar`
- "kanban" / "boards" → `apps/kanban`
- "messages" / "messaging" / "chat" / "channels" → `apps/messages`
- "videos" / "video recording" / "screen recording" → `apps/videos`
- "kitchen sink" / "UI sandbox" / "component showcase" → `dev`

### Step 2: Resolve dependencies and choices

1. Always include `core`.
2. Add every layer the user asked for.
3. Resolve dependencies — if the user asked for `mcp`, also include `oauth`.
4. **Choice groups (email backend)**: if the user mentioned a provider, use it. If they mentioned email but no provider, default to `email-mailgun`. If they didn't mention email at all, **ask** before deciding — apps that send mail (auth flows, notifications) need a backend.
5. Default to including `dev` unless the user is scaffolding for production. Always mention you'll comment it out before prod build.

### Step 3: Confirm the layer list with the user (required, no exceptions)

**Auto mode, headless mode, or any other framing does not bypass this step.** The whole point of the layer system is choice; scaffolding a wrong set is wasted work for both of you. Present the resolved list and explicitly ask about anything ambiguous:

```
Based on your description, I'll wire up these layers:

  core                  (always — foundation: auth, admin, registries, kernel)
  tenancy               (you asked for multi-tenant orgs)
  email-mailgun         (you asked for Mailgun)
  oauth                 (required by mcp)
  mcp                   (you asked for MCP)
  apps/calendar         (you asked for calendar)
  apps/kanban           (you asked for kanban)
  dev                   (UI sandbox; comment out before prod build)

A few things to confirm:
  - Anything else from the available-layers list you want?
    (apps/messages, apps/videos, apps/feedback)
  - Pin to a tag/SHA for prod, or track `master` for now?
```

**Wait for confirmation before doing anything in Step 4 onward.** Specifically:

- **Do not pick "a sensible default" for the user.** The layer set IS the decision they're making — you cannot guess it for them. "Reasonable starter" is not a fallback; "ask" is.
- **If the user didn't mention email at all**, the confirmation message must explicitly ask whether they want email. Don't silently include `email-mailgun`; don't silently omit an email backend either. The user has to say.
- **If the user didn't mention apps/* at all**, default the proposed list to no app layers and the confirmation message must list every available app layer so they can pick.
- **If you genuinely have no way to ask** (true non-interactive context with no orchestrator inbox), halt. Tell whatever invoked you that the layer list is needed. **Do not write files.** A wrong scaffold is worse than no scaffold.

### Step 4: Copy the prod template into the user's project

Pull the `prod/` directory from this repo into the user's project:

```bash
bunx giget github:Nuxtinator/nuxtinator/prod#master . --force
```

The `#master` ref is required: giget defaults to `main`, but this repo's default branch is `master`, so a bare command 404s. Run from the user's project directory. `giget` is used here only as a one-shot file-copy tool — it extracts the `prod/` subtree. The extracted template is **already wired with the consumer recipe**:

- **`layers.ts`** — the **single source of truth for layer selection**. A `LAYERS` array with one entry per available layer. Both files below import from it. This is the only file Step 5 touches.
- `nuxt.config.ts` — derives `extends:` from `LAYERS`; has the `layer()` helper + `stripLayerTsconfigs` hook.
- `scripts/sync-layers.ts` — iterates `LAYERS`, calls giget for each.
- `package.json` — `workspaces: ["_layers/*"]`, no `@nuxtinator/*` deps, `setup` + `sync-layers` scripts, `giget` devDep.
- `bunfig.toml` — `linker = "hoisted"` (required for name-based extends to resolve).
- `.env.example`, `.gitignore`, `tsconfig.json`, `eslint.config.mjs`, `public/favicon.ico`.
- `CLAUDE.md` — a short host-author guide (cross-layer aliases, where the user's own code goes, "edit `layers.ts` not `extends:`"). Copied in as-is so future sessions in the project start oriented; leave it.

You do NOT write any of these files from scratch. Steps 5–8 trim the template to what the user selected and customize branding.

### Step 5: Trim `layers.ts` to selected layers

`layers.ts` at the project root is the **single source of truth** for which layers this project uses. Both `nuxt.config.ts` (the `extends:` array) and `scripts/sync-layers.ts` (the fetcher) import the `LAYERS` array from it.

Open `layers.ts`. It contains an entry for every available nuxtinator layer. **Delete the entries for layers the user did NOT select** — don't comment them out, delete entirely. Keep load order intact: `core` first; `tenancy` second (so its multi-mode kernel overrides core's single-mode); email backend; `oauth`; `mcp`; app layers; `dev` last (and remove `dev` before production).

You do not need to touch `nuxt.config.ts` or `scripts/sync-layers.ts` — both derive from `LAYERS`.

If the user mentioned a **remote** layer not on the available-layers table — a third-party layer hosted in its own git repo — add a new `LAYERS` entry with all three fields (`id`, `pkg`, `url`); the file has a commented-out third-party example to copy. giget sources are `github:` / `gitlab:` / `bitbucket:` / `sourcehut:` only (no `file:` provider). Bun workspaces resolve cross-layer deps by package name across sources, so a third-party layer that lists `"@nuxtinator/core": "*"` will find it through the consumer's workspace as long as `core` is still in `LAYERS`. For an app the user is **writing themselves** (not hosted yet), don't add a `LAYERS` entry — those live in the `apps/<id>/` directory, which `nuxt.config.ts` globs into `extends` (see the shipped `apps/example/` and `apps/README.md`).

### Step 6: Rename the project

Open `package.json` and rename `"name": "my-project"` to the user's project name (kebab-case from the directory name is a fine default). Don't change anything else in `package.json` — `workspaces`, `scripts`, `dependencies`, `devDependencies` are all already correctly wired.

Add `_layers/` to `.gitignore`:

```gitignore
node_modules
.nuxt
.output
.env
_layers
```

### Step 7: Trim .env.example

The scaffolded `.env.example` contains the union of every layer's vars. Trim it to the layers the user selected:

- Always keep the **Core** block (`APP_TITLE`, `DATABASE_URL`, `JWT_SECRET`, `NUXT_SECRET_ENCRYPTION_KEY`, `NUXT_PUBLIC_SITE_URL`, `NODE_ENV`).
- Keep `APP_DATABASE_URL` only if `tenancy` is selected.
- Keep the `MAILGUN_*` + `SMTP_FROM*` block only if `email-mailgun` is selected.
- Keep `NUXT_SOCIAL_AUTH_*` only if `social-auth` is selected.
- Keep `OAUTH_*` only if `oauth` is selected.
- Keep `MCP_*` only if `mcp` is selected.
- Keep `S3_*` only if a layer that uploads is selected (`videos`, `messages`, etc.).
- Keep `NUXT_PUBLIC_FEEDBACK_PROJECT_ID` only if `feedback` is selected.
- Leave the `# NUXTINATOR_REF=master` and `# NUXTINATOR_<ID>_PATH=...` blocks commented as scaffolded — both are advanced opt-ins (production ref pinning; per-layer sibling-checkout override).

### Step 8: Customize branding

Update `APP_TITLE` in `.env.example` to a sensible default based on the project name (the directory name is a fine starting point). Update the `head.title` fallback in `nuxt.config.ts` if needed. Don't go beyond the title — the user will style the rest.

### Step 9: Bootstrap and verify

```bash
bun run setup
bun run dev
```

`bun run setup` runs the three-phase bootstrap defined in the `scripts` block:

1. **`bun install`** — installs the consumer's root deps (nuxt + framework peers + giget). The `_layers/*` workspaces glob doesn't match yet (directory doesn't exist), so no layers are linked. Expect ~700–800 packages.
2. **`bun run sync-layers`** — reads `LAYERS` from `layers.ts` and calls `giget` for each entry, extracting from each `url` into `_layers/<id>/`. Expect a "Fetching <id> from ..." line per layer.
3. **`bun install`** (second pass) — bun re-evaluates the workspaces glob, finds `_layers/<id>/` directories, reads each layer's `package.json`, merges their `dependencies` into the resolution graph, places everything in the root `node_modules/.bun/` content-addressable store, and symlinks each layer as `node_modules/@nuxtinator/<id>/`. Package count grows; `bun pm ls` shows `@nuxtinator/<id>@workspace:_layers/<id>` entries.

After setup, verify:

- `_layers/` contains a folder per selected layer with its source (`nuxt.config.ts`, `package.json`, the layer's own dirs).
- `_layers/<id>/node_modules/` is a directory of **symlinks** pointing into `../../../node_modules/.bun/<pkg>@<v>/...` — NOT a populated install. If you see real package directories with content here, something's off (probably the dot-prefix footgun or a stale lockfile from a previous failed run; delete `bun.lock` + `node_modules` and retry).
- `node_modules/@nuxtinator/<id>/` is a symlink to `../../_layers/<id>/`. `readlink node_modules/@nuxtinator/core` should confirm. **If this is missing**, `bunfig.toml` is wrong or absent — bun 1.3 defaults to isolated linker which doesn't create these top-level symlinks.
- `bun pm ls` lists `@nuxtinator/<id>@workspace:_layers/<id>` for each layer.
- `bun run dev` boots Nuxt on port 2080.

**Expected benign output — don't treat these as failures:**

- **`bun` blocks ~2 postinstalls** (`@parcel/watcher`, `unrs-resolver`) on the first install — that's bun's default for untrusted lifecycle scripts. Both ship prebuilt binaries, so dev still boots. Leave them blocked; only run `bun pm trust @parcel/watcher unrs-resolver` if you later hit a native-watcher error.
- **Without a filled `.env`, boot logs warnings, not errors** — `DATABASE_URL not set, skipping migrations` and (if `oauth` is loaded) `[oauth-layer] NUXT_PUBLIC_SITE_URL not set — OAuth server disabled`. Both are expected pre-configuration; a `200` on `http://localhost:2080/` means the boot succeeded.

**If migrations fail** because the user hasn't filled in `DATABASE_URL` yet, that's expected — note it in your wrap-up. Stop the dev server before reporting back (don't leave it running in the background).

### Step 10: Brief the user on what's next

After scaffolding is verified, tell the user:

- Fill in `.env` (database URL, JWT secret, encryption key, any provider credentials for the layers they selected). Generate secrets with the `openssl` commands shown in `.env.example`.
- Provision the database. For single-tenant: one role, one database — see [documentation/single-tenant-deploy.md](documentation/single-tenant-deploy.md). For multi-tenant: two roles (`host_admin` BYPASSRLS + `app_user` RLS-enforced) — see [documentation/tenancy.md](documentation/tenancy.md).
- Run `bun run dev`. The first user to register is automatically promoted to operator-admin.
- Adding a new app of their own: see [documentation/layers.md](documentation/layers.md#creating-a-new-app-layer). They can drop pages directly into the host (project-specific code), add a local app in `apps/<id>/` (globbed into extends — copy the shipped `apps/example/`), or publish a layer to its own repo and list it in `layers.ts`.
- Updating to a newer cut of nuxtinator: set `NUXTINATOR_REF=<tag-or-sha>` in `.env` (or change the default in `scripts/sync-layers.ts`), then run `bun run setup` again. `forceClean: true` in the script means each layer is re-extracted from the new ref.

### Things to **not** do

- **Don't fork the layers.** The user fetches each via `sync-layers` into `_layers/<id>/`; they never own the layer source. The extracted host is the only thing they edit.
- **Don't add layers to `LAYERS` in `layers.ts` that don't exist** in the available-layers table — unless the user has explicitly given you a giget URL for a third-party / sibling-checkout layer. If the user asks for something not on the list and provides no URL, say so and offer to scaffold a custom app for them — locally in `apps/<id>/` (globbed into extends; copy the shipped `apps/example/`), or in its own repo if they want to share it (see [layers.md](documentation/layers.md)).
- **Don't manually edit the `extends:` array** in `nuxt.config.ts` to add or remove a layer. `extends:` is derived from `layers.ts`. Editing `extends:` directly creates drift between what's in `LAYERS` (what gets fetched) and what Nuxt extends (what gets loaded). Edit `layers.ts` only.
- **Don't add `@nuxtinator/*` to the consumer's `package.json` `dependencies`** — not as `workspace:*` (only valid in this monorepo) and not as a `github:` URL (bun's `github:` dep protocol can't resolve a monorepo subpath; install will fail). Layers arrive as workspace members via the `_layers/*` glob already wired in `package.json`'s `workspaces`, not as npm deps.
- **Don't change the workspaces glob to `.layers/*`.** Bun's minimatch doesn't match dot-prefixed dirs. The template uses `_layers/*` for this exact reason. There is no error if you change it wrong — `bun install` succeeds, no symlinks get made, nothing works.
- **Don't delete `bunfig.toml`** or change `linker = "hoisted"` to `"isolated"`. Bun 1.3+ defaults to isolated, which doesn't create the top-level `node_modules/@nuxtinator/<id>` symlinks Nuxt needs to resolve `extends: [layer('@nuxtinator/core')]` by package name. Symptom of getting this wrong: `nuxt prepare` errors with `Cannot find module '@nuxtinator/<id>'`.
- **Don't add `postinstall: nuxt prepare`** to the consumer's `package.json`. It runs before layers are fetched on the first install and would error trying to extend non-existent paths. The `setup` script in the template orchestrates the right order — leave it alone.
- **Don't pin to a SHA silently** — set `NUXTINATOR_REF` in `.env` for production pins and tell the user what they're pinned to so they can bump it deliberately.
- **Don't commit `_layers/`** — it's a build-time artifact (re-fetched on every `sync-layers` run). Make sure `.gitignore` includes it.
- **Don't run a production build** during scaffolding. Verify dev only.
