// Vitest global setup for the `social-auth` project. Serves a JWKS for a
// throwaway signing key and boots Nuxt (the dev/ host) with both providers
// pointed at it, so tests can mint ID tokens the server accepts.
//
// This server's env differs from the other projects' servers, so its URL and
// the signing key reach the tests through `provide` rather than the shared
// NUXT_TEST_CONTEXT env var, which the last project to boot overwrites.
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { createTest, useTestContext } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  getHostAdminDb,
  closeTestDatabases,
  cleanupSocialTestData,
  TEST_APPLE_BUNDLE,
  TEST_GOOGLE_IOS_CLIENT,
  TEST_GOOGLE_WEB_CLIENT,
  TEST_KID
} from './helpers'

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dev')

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: TEST_KID, alg: 'RS256', use: 'sig' }

let jwksServer: Server | null = null

async function startJwksServer(): Promise<string> {
  jwksServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>(r => jwksServer!.listen(0, '127.0.0.1', () => r()))
  const addr = jwksServer.address()
  if (!addr || typeof addr === 'string') throw new Error('JWKS server failed to bind')
  return `http://127.0.0.1:${addr.port}/jwks`
}

let hooks: ReturnType<typeof createTest> | null = null

export async function setup(project: TestProject) {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set in dev/.env. Run scripts/setup-test-db.sh.'
    )
  }

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  process.env.APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL
  process.env.NODE_ENV = 'development'

  const jwksUrl = await startJwksServer()

  hooks = createTest({
    rootDir: HOST_DIR,
    server: true,
    browser: false,
    env: {
      NODE_ENV: 'development',
      NUXT_SOCIAL_AUTH_GOOGLE_CLIENT_ID: TEST_GOOGLE_WEB_CLIENT,
      NUXT_SOCIAL_AUTH_GOOGLE_CLIENT_SECRET: 'test-secret',
      NUXT_SOCIAL_AUTH_GOOGLE_NATIVE_CLIENT_IDS: TEST_GOOGLE_IOS_CLIENT,
      NUXT_SOCIAL_AUTH_GOOGLE_JWKS_URL: jwksUrl,
      NUXT_SOCIAL_AUTH_APPLE_BUNDLE_IDS: TEST_APPLE_BUNDLE,
      NUXT_SOCIAL_AUTH_APPLE_JWKS_URL: jwksUrl
    },
    nuxtConfig: {
      vite: { define: { 'process.env.NODE_ENV': JSON.stringify('development') } },
      nitro: { replace: { 'process.env.NODE_ENV': JSON.stringify('development') } }
    }
  })

  await hooks.beforeAll()
  project.provide('socialAuthUrl', useTestContext().url!)
  project.provide('socialAuthPrivateKey', privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())

  await cleanupSocialTestData(getHostAdminDb())
}

export async function teardown() {
  try {
    await cleanupSocialTestData(getHostAdminDb())
  } finally {
    await closeTestDatabases()
    await hooks?.afterAll()
    jwksServer?.close()
  }
}
