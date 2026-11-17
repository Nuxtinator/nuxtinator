import { LAYERS } from './layers'

declare const process: { env: Record<string, string | undefined> }

// Resolve where each layer comes from. By default, `extends:` uses the layer's
// package name (`@nuxtinator/<id>`), which resolves via standard node module
// resolution against `node_modules/` — workspace symlink in this monorepo.
//
// Per-layer local override: set `NUXTINATOR_<ID>_PATH` (id uppercased, hyphens
// and slashes become underscores) to point an individual layer at a sibling
// checkout on disk. e.g. `NUXTINATOR_MESSAGES_PATH=../../scratch/messages`.
function layer(pkg: string): string {
  const envKey = pkg.replace(/^@/, '').replace(/[/-]/g, '_').toUpperCase() + '_PATH'
  return process.env[envKey] || pkg
}

// https://nuxt.com/docs/api/configuration/nuxt-config
//
// This is the maintainer dev host shell. Layer selection lives in ./layers.ts.
// Kept intentionally close to prod/nuxt.config.ts (two hosts, one shape). Only
// HOST-authoritative config lives here; each layer declares its own
// runtimeConfig (mcpServer* in @nuxtinator/mcp, public.feedbackProjectId in @nuxtinator/feedback).
export default defineNuxtConfig({

  extends: LAYERS.map(l => layer(l.pkg)),

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
    // Foundation modules (migrations, tenant-kernel, email-kernel) are
    // declared inside `layers/core/nuxt.config.ts`.
  ],

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
    // NUXT_HOST / NUXT_PORT in dev/.env override per-instance without touching
    // this file. When running several nuxtinator projects side by side, set
    // NUXT_HOST to a named host (e.g. myproject.localhost) to give each its
    // own cookie jar — cookies ignore ports, so two apps on localhost share
    // logged-in sessions. A named host must resolve locally: add
    // `127.0.0.1 <host>` to /etc/hosts.
    host: process.env.NUXT_HOST || 'localhost',
    port: Number(process.env.NUXT_PORT) || 2080
  },

  compatibilityDate: '2025-01-15',

  vite: {
    server: {
      // Leading dot = accept any *.localhost Host header, so NUXT_HOST
      // overrides don't also need an allowedHosts change.
      allowedHosts: ['.localhost']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
