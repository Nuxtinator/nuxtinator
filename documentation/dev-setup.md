# Dev setup

How to work on **this repo** (the nuxtinator monorepo) — develop layers, iterate on the maintainer host. If you instead want to start a new project that *consumes* nuxtinator layers, see [getting-started.md](getting-started.md).

## Quick start

```bash
git clone <this repo>
cd go-saas
bun install                                          # installs the bun workspace
cp dev/.env.example dev/.env                         # then fill in DATABASE_URL etc.
cd dev && bun run dev
```

Dev server: <http://localhost:2080>.

## Repo shape

```
go-saas/
├── package.json         ← workspace root (lists dev + layers as workspaces)
├── bun.lock             ← single lockfile for the whole monorepo
├── bunfig.toml          ← linker = "hoisted" so layers see dev's peer deps
├── node_modules/        ← hoisted; layers resolve deps from here
│
├── dev/                 ← maintainer's dev host (was host/ — cwd for all dev/build commands)
│   ├── layers.ts        ← LAYERS array (id + pkg per layer) — source of truth for extends:
│   ├── nuxt.config.ts   ← imports LAYERS; extends: derived
│   ├── package.json     ← dev-only deps (nuxt, ui, kysely/postgres, tailwind) + workspace:* refs
│   └── .env, .env.example
│
├── prod/                ← consumer-starter template (copied by downstream projects via giget)
│                          NOT used for dev-on-the-monorepo work; see getting-started.md
│
└── layers/              ← reusable layers (siblings of dev/ and prod/)
    ├── core/            ← always-on foundation
    │   └── package.json ← bcrypt, jsonwebtoken, s3-lite-client; nuxt/kit/ui/kysely peer
    ├── tenancy/         ← optional multi-tenant (peer-deps only)
    ├── mail/            ← always: the mail kernel (@nuxtinator/mail)
    ├── oauth/, mcp/, dev/   (note: `layers/dev/` is the @nuxtinator/dev UI-sandbox layer —
    │                         distinct from the top-level `dev/` host folder)
    └── apps/calendar/, apps/kanban/, apps/messages/, apps/videos/, apps/feedback/, apps/list-of-100/
```

Each layer has its own `package.json` declaring exactly what it imports — layer-private deps in `dependencies`, cross-layer deps as `workspace:*` (e.g. `"@nuxtinator/core": "workspace:*"`), and framework/DB singletons in `peerDependencies` so they resolve to dev's installed copy.

Run all dev/build commands from `dev/`:

```
bun run dev          # dev server (port 2080, runs migrations on boot)
bun run build        # prod build
bun run preview      # preview built app
bun run lint         # eslint
bun run typecheck    # vue-tsc / nuxt typecheck
```

## How layers are wired

Each layer is a named workspace package — `@nuxtinator/<id>` with `exports: { ".": "./nuxt.config.ts" }`. [dev/layers.ts](../dev/layers.ts) is the **single source of truth** for which layers `dev/` extends:

```ts
// dev/layers.ts
export const LAYERS = [
  { id: 'core',     pkg: '@nuxtinator/core' },
  { id: 'tenancy',  pkg: '@nuxtinator/tenancy' },
  // ...one entry per layer dev/ uses, in load order...
] as const
```

[dev/nuxt.config.ts](../dev/nuxt.config.ts) imports `LAYERS` and derives `extends:`:

```ts
import { LAYERS } from './layers'

function layer(pkg: string): string {
  const envKey = pkg.replace(/^@/, '').replace(/[/-]/g, '_').toUpperCase() + '_PATH'
  return process.env[envKey] || pkg
}

extends: LAYERS.map(l => layer(l.pkg))
```

In this repo, each `@nuxtinator/*` is also declared as `workspace:*` in [dev/package.json](../dev/package.json), so bun symlinks `node_modules/@nuxtinator/<id>/` to `layers/<id>/`. **`dev/layers.ts` and `dev/package.json`'s deps block must agree** — bun needs the explicit dep entry to create the symlink, and Nuxt needs the `LAYERS` entry to extend. The same `extends:` line also works when a package arrives via npm tarball or a `github:org/repo#ref` URL in a downstream consumer's deps — one resolution mode for all three sources.

Each layer's `package.json` declares its real cross-layer deps (`"@nuxtinator/core": "workspace:*"`) and its layer-private deps. Framework/DB singletons (`nuxt`, `@nuxt/kit`, `@nuxt/ui`, `kysely`, `kysely-postgres-js`, `postgres`, `h3`, `vue`, `tailwindcss`) stay in `peerDependencies` so they resolve to dev's single copy.

### Per-layer local override

Set `NUXTINATOR_<ID>_PATH` to point an individual layer at a sibling checkout on disk (id uppercased, hyphens become underscores):

```sh
# dev/.env
NUXTINATOR_MESSAGES_PATH=../../scratch/messages-experiment
```

The `layer()` helper reads it and returns that path instead of the package name. Everything else stays on package-name resolution. `bun link @nuxtinator/messages` against a `bun link`ed sibling repo has the same effect without committed config.

## Adding a layer

1. Create `layers/<id>/` with code + `package.json`:
   - `"name": "@nuxtinator/<id>"`
   - `"exports": { ".": "./nuxt.config.ts" }`
   - `dependencies` for what it imports (including cross-layer deps like `"@nuxtinator/core": "workspace:*"`)
   - `peerDependencies` for shared singletons (`nuxt`, `vue`, `kysely`, etc.)
2. Add `"layers/<id>"` to the `workspaces` array in the root [package.json](../package.json).
3. Add `"@nuxtinator/<id>": "workspace:*"` to `dev/package.json` `dependencies`.
4. Add `{ id: '<id>', pkg: '@nuxtinator/<id>' }` to the `LAYERS` array in [dev/layers.ts](../dev/layers.ts) (in load order). **Do not** edit `dev/nuxt.config.ts`'s `extends:` array directly — it's derived from `LAYERS`.
5. `bun install` from root, then `cd dev && bun run dev`.

For the consumer-side `prod/` template, also add a matching entry to [prod/layers.ts](../prod/layers.ts) so downstream projects can opt into the new layer. The shape there has an additional `url` field (the giget source URL).

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find package '<x>' imported from layers/<name>/...` | The layer imports `<x>` but doesn't declare it (and host doesn't either) | Add `<x>` to the layer's `package.json` — `dependencies` if it's layer-private, `peerDependencies` if it's a shared singleton (DB/framework) |
| `Cannot find package '@nuxtinator/<x>' imported from @nuxtinator/<name>` | Cross-layer dep missing in the importing layer's `package.json` | Add `"@nuxtinator/<x>": "workspace:*"` to the importing layer's `dependencies` |
| `Failed to resolve import "~/assets/css/main.css"` from a virtual nuxt module | Host references a CSS file that lives in a layer; the `~/` alias points at the host's tree | Layer should declare its own CSS in its `nuxt.config.ts` (see [layers/core/nuxt.config.ts](../layers/core/nuxt.config.ts) for the pattern) |
| Dev seems to run but never finds layers; mentions `dev/dev/.nuxt` | `dev/package.json` scripts have a stray `host` arg (`nuxt dev host` instead of `nuxt dev`) | Drop the arg; commands run with cwd `dev/` |
| Migrations fail with DB connection errors | Postgres isn't running, or `DATABASE_URL` / `APP_DATABASE_URL` aren't set | Start Postgres and check `dev/.env`. See [single-tenant-deploy.md](./single-tenant-deploy.md) for DB role setup |

## Production deploy summary

- Build context must include the workspace root so `node_modules/@nuxtinator/*` resolves. `bun install && cd dev && bun run build` from the repo root.
- Run: standard Nuxt output under `dev/.output/` — see Nuxt deployment docs for your target.

For full deployment guidance see [single-tenant-deploy.md](./single-tenant-deploy.md).
