// Vitest global setup for the `social-auth` project. Serves a JWKS for a
// throwaway signing key and boots Nuxt (the dev/ host) with both providers
// pointed at it, so tests can mint ID tokens the server accepts.
//
// This server's env differs from the other projects' servers, so its URL and
// the signing key reach the tests through `provide` rather than the shared
// NUXT_TEST_CONTEXT env var, which the last project to boot overwrites.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { TestProject } from 'vitest/node'
import { createTest, useTestContext } from '@nuxt/test-utils/e2e'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
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

// 1x1 PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000d49444154789c63f8cf000000010100000118c4f3a90000000049454e44ae426082',
  'hex'
)

let photoServer: Server | null = null
let plainPhotoServer: Server | null = null
let certDir: string | null = null

function servePhoto(redirects: Record<string, string>) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const location = redirects[req.url ?? '']
    if (location) res.writeHead(302, { location }).end()
    else if (req.url === '/photo.png') res.writeHead(200, { 'content-type': 'image/png' }).end(TINY_PNG)
    else res.writeHead(404).end()
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, () => r()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Photo server failed to bind')
  return addr.port
}

// A provider photo host at https://localhost with a throwaway certificate, plus
// a plain-HTTP twin that only the /to-http redirect points at.
async function startPhotoServers(): Promise<{ baseUrl: string, certFile: string }> {
  certDir = mkdtempSync(join(tmpdir(), 'social-photo-'))
  const keyFile = join(certDir, 'key.pem')
  const certFile = join(certDir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' })

  plainPhotoServer = createServer(servePhoto({}))
  const plainPort = await listen(plainPhotoServer)
  const redirects: Record<string, string> = {
    '/redirect': '/photo.png',
    '/to-http': `http://localhost:${plainPort}/photo.png`
  }
  photoServer = createHttpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, servePhoto(redirects))
  const port = await listen(photoServer)
  redirects['/to-ip'] = `https://127.0.0.1:${port}/photo.png`
  return { baseUrl: `https://localhost:${port}`, certFile }
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
  const photo = await startPhotoServers()

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
      NUXT_SOCIAL_AUTH_APPLE_JWKS_URL: jwksUrl,
      // 127.0.0.1 is listed so only the IP-address rule refuses the /to-ip redirect.
      NUXT_SOCIAL_AUTH_GOOGLE_PHOTO_HOSTS: 'localhost,127.0.0.1',
      // Trusts the photo host's self-signed certificate.
      NODE_EXTRA_CA_CERTS: photo.certFile
    },
    nuxtConfig: {
      vite: { define: { 'process.env.NODE_ENV': JSON.stringify('development') } },
      nitro: { replace: { 'process.env.NODE_ENV': JSON.stringify('development') } }
    }
  })

  await hooks.beforeAll()
  project.provide('socialAuthUrl', useTestContext().url!)
  project.provide('socialAuthPrivateKey', privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
  project.provide('socialPhotoBaseUrl', photo.baseUrl)

  await cleanupSocialTestData(getHostAdminDb())
}

export async function teardown() {
  try {
    await cleanupSocialTestData(getHostAdminDb())
  } finally {
    await closeTestDatabases()
    await hooks?.afterAll()
    jwksServer?.close()
    photoServer?.close()
    plainPhotoServer?.close()
    if (certDir) rmSync(certDir, { recursive: true, force: true })
  }
}
