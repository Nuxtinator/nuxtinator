// Which layers this dev host extends.
//
// This is the maintainer-side counterpart to prod/layers.ts. Same shape, one
// field fewer — no `url` because layers come from workspace symlinks in this
// monorepo, not from giget. `nuxt.config.ts` imports `LAYERS` from here and
// derives its `extends:` array.
//
// Each entry has two fields:
//   id   — bare slug used in the NUXTINATOR_<ID>_PATH env-var override
//   pkg  — package name Nuxt's extends: resolves; matches each layer's
//          package.json `name`
//
// Load order matters. core first; tenancy second so its multi-mode kernel
// overrides core's single-mode; email backend; oauth; mcp; app layers;
// dev last (the @nuxtinator/dev sandbox layer — distinct from this dev/
// host folder).
//
// IMPORTANT: dev/package.json must declare `"@nuxtinator/<id>": "workspace:*"`
// in `dependencies` for every entry below. Bun needs the explicit dep entry
// to symlink workspace members into dev/node_modules/@nuxtinator/<id>/.
// Adding a layer = add an entry here AND a workspace:* dep in package.json.

export const LAYERS = [
  { id: 'core', pkg: '@nuxtinator/core' },
  { id: 'tenancy', pkg: '@nuxtinator/tenancy' },
  { id: 'email-mailgun', pkg: '@nuxtinator/email-mailgun' },
  { id: 'social-auth', pkg: '@nuxtinator/social-auth' },
  { id: 'ai', pkg: '@nuxtinator/ai' },
  { id: 'oauth', pkg: '@nuxtinator/oauth' },
  { id: 'mcp', pkg: '@nuxtinator/mcp' },
  { id: 'messages', pkg: '@nuxtinator/messages' },
  { id: 'videos', pkg: '@nuxtinator/videos' },
  { id: 'feedback', pkg: '@nuxtinator/feedback' },
  { id: 'list-of-100', pkg: '@nuxtinator/list-of-100' },
  { id: 'files', pkg: '@nuxtinator/files' },
  { id: 'context', pkg: '@nuxtinator/context' },
  { id: 'crm', pkg: '@nuxtinator/crm' },
  { id: 'inbox', pkg: '@nuxtinator/inbox' },
  { id: 'helpinator', pkg: '@nuxtinator/helpinator' },
  { id: 'dev', pkg: '@nuxtinator/dev' }
] as const
