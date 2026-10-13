// Vitest config — one project per layer. Projects run in parallel by default;
// each project's files run serial (per-test cleanup is reliable, file-level
// parallelism would race). Each layer prefixes its test data so layers
// running in parallel can't collide.
//
// Add new layers by appending another `layerProject(...)` entry.

import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import { resolve } from 'node:path'

// MUST be set before vitest defaults NODE_ENV to 'test'. The Nuxt/Nitro
// build inlines `process.env.NODE_ENV` into the bundle, and the email layer
// switches Mailpit vs. Mailgun on `=== 'development'`. With NODE_ENV='test'
// at build time, the bundled `isDevelopment` is forever false → real Mailgun
// → tests fail. Setting it here pins it through the build.
process.env.NODE_ENV = 'development'

const env = loadEnv('test', process.cwd(), '')

// Forward test DB URLs into the test process. The per-layer global-setup
// then promotes them to DATABASE_URL / APP_DATABASE_URL for the spawned Nuxt.
// S3 credentials come along too so tests can assert directly against the
// bucket (e.g. that org offboarding actually removed the objects).
for (const k of ['TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'JWT_SECRET', 'TEST_MAILHOG_URL', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME']) {
  if (env[k]) process.env[k] = env[k]
}

interface LayerProject {
  test: {
    name: string
    include: string[]
    globalSetup: string[]
    fileParallelism: false
    testTimeout: number
    sequence: { hooks: 'list' }
  }
}

function layerProject(name: string, root: string): LayerProject {
  return {
    test: {
      name,
      include: [resolve(__dirname, root, '**/*.test.ts')],
      globalSetup: [resolve(__dirname, root, 'global-setup.ts')],
      fileParallelism: false,
      testTimeout: 60_000,
      sequence: { hooks: 'list' }
    }
  }
}

export default defineConfig({
  // Don't wipe the terminal between runs — kills the test summary in some
  // shells and obscures historical results in scrollback.
  clearScreen: false,
  test: {
    reporters: ['verbose'],
    // Per-layer projects. Projects run in parallel; files within each project
    // are serial (fileParallelism: false above).
    projects: [
      layerProject('core', '../layers/core/tests'),
      layerProject('tenancy', '../layers/tenancy/tests'),
      layerProject('social-auth', '../layers/social-auth/tests'),
      layerProject('messages', '../layers/apps/messages/tests'),
      layerProject('videos', '../layers/apps/videos/tests'),
      layerProject('feedback', '../layers/apps/feedback/tests'),
      layerProject('list-of-100', '../layers/apps/list-of-100/tests'),
      layerProject('files', '../layers/apps/files/tests'),
      layerProject('context', '../layers/apps/context/tests'),
      layerProject('crm', '../layers/apps/crm/tests'),
      layerProject('inbox', '../layers/apps/inbox/tests'),
      layerProject('helpinator', '../layers/apps/helpinator/tests'),
      layerProject('ai', '../layers/ai/tests')
    ]
  }
})
