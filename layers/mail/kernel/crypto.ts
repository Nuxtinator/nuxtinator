// Crypto helpers that take their key as an argument.
//
// `encryptSecret`/`decryptSecret` use the same format as core's
// secret-crypto.ts (AES-256-GCM, base64 of iv | tag | ciphertext), so either
// side reads the other's output given the same NUXT_SECRET_ENCRYPTION_KEY.
//
// Outbox bodies are sealed to an X25519 public key: any process holding the
// public key can encrypt, only one holding the secret key can decrypt.
import crypto from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export function parseSecretKey(hex: string): Buffer {
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== KEY_BYTES) {
    throw new Error(`The secret key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars); got ${buf.length} bytes`)
  }
  return buf
}

function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

function aesDecrypt(key: Buffer, buf: Buffer): Buffer {
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short')
  const decipher = crypto.createDecipheriv(ALGO, key, buf.subarray(0, IV_BYTES))
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
}

export function encryptSecret(secretKeyHex: string, plaintext: string): string {
  return aesEncrypt(parseSecretKey(secretKeyHex), Buffer.from(plaintext, 'utf8')).toString('base64')
}

export function decryptSecret(secretKeyHex: string, ciphertext: string): string {
  return aesDecrypt(parseSecretKey(secretKeyHex), Buffer.from(ciphertext, 'base64')).toString('utf8')
}

export function encryptJson(secretKeyHex: string, value: unknown): string {
  return encryptSecret(secretKeyHex, JSON.stringify(value))
}

export function decryptJson<T = unknown>(secretKeyHex: string, ciphertext: string): T {
  return JSON.parse(decryptSecret(secretKeyHex, ciphertext)) as T
}

// A 32-byte key derived from the secret key for one purpose, so no two uses
// share key material.
export function deriveKey(secretKeyHex: string, label: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', parseSecretKey(secretKeyHex), Buffer.alloc(0), `nuxtinator-mail/${label}`, 32))
}

export function hmacHex(key: Buffer | string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// DER prefixes that wrap a raw 32-byte X25519 key as PKCS#8 / SPKI.
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

function privateKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' })
}

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' })
}

function rawPublicKey(key: crypto.KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer
  return der.subarray(der.length - 32)
}

export interface OutboxKeyPair {
  privateKey: crypto.KeyObject
  publicKey: string
}

export function outboxKeyPair(secretKeyHex: string): OutboxKeyPair {
  const privateKey = privateKeyFromRaw(deriveKey(secretKeyHex, 'outbox-x25519'))
  const publicKey = rawPublicKey(crypto.createPublicKey(privateKey)).toString('base64url')
  return { privateKey, publicKey }
}

function sealKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), 'nuxtinator-mail/outbox-seal', 32))
}

const SEAL_VERSION = 'x1.'

export function seal(publicKeyB64: string, plaintext: string): string {
  const recipientRaw = Buffer.from(publicKeyB64, 'base64url')
  if (recipientRaw.length !== 32) throw new Error('The outbox public key must be 32 bytes, base64url-encoded')
  const recipient = publicKeyFromRaw(recipientRaw)
  const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync('x25519')
  const ephRaw = rawPublicKey(ephPub)
  const shared = crypto.diffieHellman({ privateKey: ephPriv, publicKey: recipient })
  const body = aesEncrypt(sealKey(shared, ephRaw, recipientRaw), Buffer.from(plaintext, 'utf8'))
  return SEAL_VERSION + Buffer.concat([ephRaw, body]).toString('base64')
}

export function unseal(keys: OutboxKeyPair, sealed: string): string {
  if (!sealed.startsWith(SEAL_VERSION)) throw new Error('Unknown outbox body format')
  const buf = Buffer.from(sealed.slice(SEAL_VERSION.length), 'base64')
  const ephRaw = buf.subarray(0, 32)
  const recipientRaw = Buffer.from(keys.publicKey, 'base64url')
  const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: publicKeyFromRaw(ephRaw) })
  try {
    return aesDecrypt(sealKey(shared, ephRaw, recipientRaw), buf.subarray(32)).toString('utf8')
  } catch {
    throw new Error('The outbox body was sealed to a different key (was the secret key rotated?)')
  }
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url')
}
