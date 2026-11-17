import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LAYERS } from './layers'

declare const process: { env: Record<string, string | undefined> }

const LAYERS_DIR = '_layers'

// Layers extracted from a full Nuxt project ship a tsconfig.json that
// references generated paths Vite's tsconfig walker can crash on. Strip
// them defensively before module loading.
function stripLayerTsconfigs() {
  if (!existsSync(LAYERS_DIR)) return
  for (const name of readdirSync(LAYERS_DIR)) {
    const t = join(LAYERS_DIR, name, 'tsconfig.json')
    if (existsSync(t)) rmSync(t)
  }
}
stripLayerTsconfigs()

// Resolve each layer by package name. Per-layer local override via env var:
// set NUXTINATOR_<ID>_PATH=../../sibling-checkout to point one layer at a
// local working copy without touching layers.ts (id uppercased; hyphens
// and slashes become underscores). Without an override, the package name
// resolves through node_modules/@nuxtinator/<id>/ (the bun workspace symlink
// created from _layers/<id>/).
function layer(pkg: string): string {
  const envKey = pkg.replace(/^@/, '').replace(/[/-]/g, '_').toUpperCase() + '_PATH'
  return process.env[envKey] || pkg
}

// Your own app layers live in ./apps/<id>/ — committed source you own. Nuxt
// only auto-discovers a directory literally named `layers/`, so we glob `apps/`
// into extends ourselves. Each subdirectory is loaded as a layer; adding one is
// zero-config (just drop the folder in). Fetched nuxtinator layers come from
// _layers/ via layers.ts and are listed first; your apps stack on top.
function localApps(): string[] {
  if (!existsSync('apps')) return []
  return readdirSync('apps', { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => `./apps/${d.name}`)
}

// https://nuxt.com/docs/api/configuration/nuxt-config
//
// Standalone starter config — copy this whole prod/ folder to begin a project,
// then edit this file freely. Layer selection lives in ./layers.ts. Only
// HOST-authoritative config (branding + infra secrets) lives here; each layer
// declares its own runtimeConfig (mcpServer* in @nuxtinator/mcp, public.feedbackProjectId in @nuxtinator/feedback,
// public.tenancy in @nuxtinator/core).
export default defineNuxtConfig({

  extends: [...LAYERS.map(l => layer(l.pkg)), ...localApps()],

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
    // Foundation modules (migrations, tenant-kernel, email-kernel) are
    // declared inside @nuxtinator/core itself.
  ],

  hooks: { 'modules:before': stripLayerTsconfigs },

  ssr: false,

  devtools: {
    enabled: true
  },

  app: {
    head: {
      title: process.env.APP_TITLE || 'My App'
    }
  },

  ui: {
    theme: {
      colors: ['primary', 'secondary', 'info', 'success', 'warning', 'error', 'neutral']
    }
  },

  runtimeConfig: {
    appName: process.env.APP_TITLE || 'My App',
    databaseUrl: process.env.DATABASE_URL || '',
    appDatabaseUrl: process.env.APP_DATABASE_URL || '',
    jwtSecret: process.env.JWT_SECRET || '',
    s3Endpoint: process.env.S3_ENDPOINT || '',
    s3Region: process.env.S3_REGION || '',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    s3BucketName: process.env.S3_BUCKET_NAME || '',
    s3PublicBucketName: process.env.S3_PUBLIC_BUCKET_NAME || '',
    s3PublicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '',
    secretEncryptionKey: process.env.NUXT_SECRET_ENCRYPTION_KEY || '',
    public: {
      appName: process.env.APP_TITLE || 'My App',
      nodeEnv: process.env.NODE_ENV || '',
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || ''
    }
  },

  devServer: {
    port: 2080
  },

  // Each _layers/<id>/ is a workspace member. Under hoisted linker (bunfig.toml),
  // layer deps mostly live at root node_modules/.bun/, but per-member symlink
  // dirs can still trip Vite's recursive watcher on macOS at scale. Belt-and-suspenders:
  vite: {
    server: {
      watch: {
        ignored: ['**/_layers/*/node_modules/**', '**/node_modules/**']
      }
    }
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
