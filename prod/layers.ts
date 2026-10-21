// Which nuxtinator layers this project uses.
//
// SINGLE SOURCE OF TRUTH for remote layer selection. Both nuxt.config.ts (the
// `extends:` array) and scripts/sync-layers.ts read from it.
//
// YOUR OWN apps don't go here. Drop them in ./apps/<id>/ — nuxt.config.ts globs
// that directory into `extends`, so a new app loads with no entry here, no
// fetch, no install. Use this file only for layers pulled from a remote repo.
//
// Each entry:
//   id        — directory under _layers/<id>/ (also the NUXTINATOR_<ID>_PATH slug)
//   pkg       — package name Nuxt's extends: resolves (matches the layer's package.json `name`)
//   repo      — owner/name of the source repo (listed on every entry for clarity; defaults to Nuxtinator/nuxtinator)
//   subdir    — path to the layer inside its source repo
//   tagPrefix — tag namespace (default: `@nuxtinator/<id>@`); own-repo layers use 'v'
//   version   — update policy (default 'latest'):
//                 'latest'  newest released tag, else master — auto-update (the default)
//                 '^1.4.0'  newest 1.x: take minor + patch automatically, hold majors
//                 '~1.4.0'  newest 1.4.x: patch only
//                 '1.4.0'   exact pin
//                 'master' / a branch / a SHA — track a raw ref (bleeding edge)
//
// `version` is resolved to a concrete tag by scripts/sync-layers.ts (via
// layers:update) and recorded in layers.lock.json (committed). Set NUXTINATOR_REF
// in .env to override the ref for ALL layers at once (a global pin escape hatch).
//
// Load order matters. core first; tenancy second so its multi-mode kernel
// overrides core's single-mode; email backend; oauth; mcp; app layers; dev last.

import type { LayerSpec } from './scripts/lib/resolve'

export const LAYERS: readonly LayerSpec[] = [
  { id: 'core',          pkg: '@nuxtinator/core',          repo: 'Nuxtinator/nuxtinator', subdir: 'layers/core' },
  { id: 'tenancy',       pkg: '@nuxtinator/tenancy',       repo: 'Nuxtinator/nuxtinator', subdir: 'layers/tenancy' },
  { id: 'email-mailgun', pkg: '@nuxtinator/email-mailgun', repo: 'Nuxtinator/nuxtinator', subdir: 'layers/email-mailgun' },
  { id: 'social-auth',   pkg: '@nuxtinator/social-auth',   repo: 'Nuxtinator/nuxtinator', subdir: 'layers/social-auth' },
  { id: 'ai',            pkg: '@nuxtinator/ai',            repo: 'Nuxtinator/nuxtinator', subdir: 'layers/ai' },
  { id: 'oauth',         pkg: '@nuxtinator/oauth',         repo: 'Nuxtinator/nuxtinator', subdir: 'layers/oauth' },
  { id: 'mcp',           pkg: '@nuxtinator/mcp',           repo: 'Nuxtinator/nuxtinator', subdir: 'layers/mcp' },
  { id: 'feedback',      pkg: '@nuxtinator/feedback',      repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/feedback' },
  { id: 'list-of-100',   pkg: '@nuxtinator/list-of-100',   repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/list-of-100' },
  { id: 'messages',      pkg: '@nuxtinator/messages',      repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/messages' },
  { id: 'videos',        pkg: '@nuxtinator/videos',        repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/videos' },
  { id: 'files',         pkg: '@nuxtinator/files',         repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/files' },
  { id: 'context',       pkg: '@nuxtinator/context',       repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/context' },
  // Needs context + ai. Add crm + inbox too for the "still need help?" handoff.
  { id: 'helpinator',    pkg: '@nuxtinator/helpinator',    repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/helpinator' },
  { id: 'crm',           pkg: '@nuxtinator/crm',           repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/crm' },
  { id: 'dev',           pkg: '@nuxtinator/dev',           repo: 'Nuxtinator/nuxtinator', subdir: 'layers/dev' }

  // Pin a first-party layer to auto-take 1.x minors/patches but hold majors:
  //   { id: 'feedback', pkg: '@nuxtinator/feedback', repo: 'Nuxtinator/nuxtinator', subdir: 'layers/apps/feedback', version: '^1.0.0' },
  //
  // A third-party layer that is the only one in its repo — tags are usually plain `v1.2.3`:
  //   { id: 'contacts', pkg: '@acme/contacts', repo: 'acme/contacts-layer', subdir: '.', tagPrefix: 'v', version: '^0.5.0' },
  //
  // Third-party layers sharing ONE repo (a monorepo, like this one): same `repo`, different
  // `subdir`, and a per-layer `tagPrefix` so each keeps its own version line:
  //   { id: 'crm',     pkg: '@acme/crm',     repo: 'acme/suite', subdir: 'layers/crm',     tagPrefix: '@acme/crm@',     version: '^2.0.0' },
  //   { id: 'billing', pkg: '@acme/billing', repo: 'acme/suite', subdir: 'layers/billing', tagPrefix: '@acme/billing@', version: '^2.0.0' }
]
