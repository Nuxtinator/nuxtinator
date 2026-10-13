import { S3Client, S3Errors, type S3ResponseOverrideParams } from '@bradenmacdonald/s3-lite-client'
import { randomBytes } from 'crypto'

// S3 Client instance (will be initialized lazily)
let s3Client: S3Client | null = null

const SIGNED_URL_EXPIRATION = 60 * 60 * 24 * 7 // 7 days in seconds

// Get S3 settings from environment variables
function getS3Settings() {
  // Try to get runtime config first (for production builds), then fallback to process.env
  let S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_NAME, S3_PUBLIC_BUCKET_NAME, S3_PUBLIC_BASE_URL

  try {
    // Use runtime config if available (production build)
    const config = useRuntimeConfig()
    S3_ENDPOINT = config.s3Endpoint || process.env.S3_ENDPOINT
    S3_REGION = config.s3Region || process.env.S3_REGION
    S3_ACCESS_KEY_ID = config.s3AccessKeyId || process.env.S3_ACCESS_KEY_ID
    S3_SECRET_ACCESS_KEY = config.s3SecretAccessKey || process.env.S3_SECRET_ACCESS_KEY
    S3_BUCKET_NAME = config.s3BucketName || process.env.S3_BUCKET_NAME
    S3_PUBLIC_BUCKET_NAME = config.s3PublicBucketName || process.env.S3_PUBLIC_BUCKET_NAME
    S3_PUBLIC_BASE_URL = config.s3PublicBaseUrl || process.env.S3_PUBLIC_BASE_URL
  } catch {
    // Fallback to process.env (development mode)
    S3_ENDPOINT = process.env.S3_ENDPOINT
    S3_REGION = process.env.S3_REGION
    S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID
    S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY
    S3_BUCKET_NAME = process.env.S3_BUCKET_NAME
    S3_PUBLIC_BUCKET_NAME = process.env.S3_PUBLIC_BUCKET_NAME
    S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL
  }

  return {
    endpoint: S3_ENDPOINT,
    region: S3_REGION || 'us-west-004',
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucketName: S3_BUCKET_NAME,
    publicBucketName: S3_PUBLIC_BUCKET_NAME,
    publicBaseUrl: S3_PUBLIC_BASE_URL
  }
}

// Whether public uploads can work: credentials, a bucket and a public base URL
// are all set. Lets callers with a non-storage fallback skip the attempt.
export function isPublicStorageConfigured(): boolean {
  const settings = getS3Settings()
  return !!(settings.endpoint && settings.accessKeyId && settings.secretAccessKey
    && (settings.publicBucketName || settings.bucketName) && settings.publicBaseUrl)
}

// The bucket that public objects live in. Public uploads can be routed to a
// dedicated public-read bucket (S3_PUBLIC_BUCKET_NAME, bound to a CDN custom
// domain); when it's unset they fall back to the primary bucket. Both share
// the same endpoint and credentials — only the bucket name differs.
function getPublicBucketName(): string | undefined {
  const settings = getS3Settings()
  return settings.publicBucketName || settings.bucketName
}

// Initialize S3 client with current settings
function initializeS3Client() {
  const settings = getS3Settings()

  if (!settings.endpoint || !settings.accessKeyId || !settings.secretAccessKey || !settings.bucketName) {
    throw new Error('S3 configuration is incomplete. Please set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET_NAME environment variables.')
  }

  s3Client = new S3Client({
    endPoint: settings.endpoint,
    region: settings.region,
    bucket: settings.bucketName,
    accessKey: settings.accessKeyId,
    secretKey: settings.secretAccessKey,
    pathStyle: true // Required for B2
  })

  return s3Client
}

// Get S3 client (initialize if needed)
function getS3Client() {
  if (!s3Client) {
    return initializeS3Client()
  }
  return s3Client
}

export interface UploadResult {
  url: string
  key: string
  filename: string
}

/**
 * Upload a file to S3-compatible storage (Backblaze B2).
 * Objects are stored under `folder/` (default `uploads/`) with a random name;
 * pass a folder to keep an app or layer's files grouped under their own prefix.
 * `visibility: 'public'` writes to the public-read bucket and returns a stable
 * public URL; `'private'` writes to the primary bucket and returns a
 * time-limited signed URL.
 */
export async function uploadToS3(
  fileData: Buffer,
  originalFilename: string,
  contentType: string,
  visibility: 'public' | 'private' = 'private',
  folder: string = 'uploads'
): Promise<UploadResult> {
  try {
    const client = getS3Client()

    // Store under the given top-level folder (surrounding slashes ignored),
    // with a random filename to avoid collisions.
    const ext = originalFilename.split('.').pop()
    const randomName = randomBytes(16).toString('hex')
    const prefix = folder.replace(/^\/+|\/+$/g, '') || 'uploads'
    const key = `${prefix}/${randomName}.${ext}`

    // Upload to S3. Public objects go to the public-read bucket; private
    // objects stay in the primary bucket (the client's default).
    await client.putObject(key, fileData as Uint8Array<ArrayBuffer>, {
      metadata: {
        'Content-Type': contentType
      },
      ...(visibility === 'public' ? { bucketName: getPublicBucketName() } : {})
    })

    // Generate URL based on visibility: public returns a stable URL via the
    // configured public base, private returns a time-limited signed URL
    const url = visibility === 'public' ? getPublicUrl(key) : await generateSignedUrl(key)

    return {
      url,
      key,
      filename: originalFilename
    }
  } catch (error: any) {
    console.error('S3 upload error:', error)
    throw new Error(`Failed to upload file to storage: ${error.message}`)
  }
}

/**
 * Build a stable public URL for an object key, using S3_PUBLIC_BASE_URL
 * (e.g. a Cloudflare R2 custom domain). Throws if the base URL is not set.
 */
export function getPublicUrl(key: string): string {
  const settings = getS3Settings()
  if (!settings.publicBaseUrl) {
    throw new Error('S3_PUBLIC_BASE_URL is not configured. Set it to your bucket\'s public custom domain to use public uploads or public URLs.')
  }
  const base = settings.publicBaseUrl.replace(/\/$/, '')
  return `${base}/${key}`
}

/**
 * Delete a file from S3-compatible storage. Pass `visibility: 'public'` to
 * delete from the public-read bucket; defaults to the primary bucket.
 */
export async function deleteFromS3(key: string, visibility: 'public' | 'private' = 'private'): Promise<void> {
  try {
    const client = getS3Client()
    await client.deleteObject(key, visibility === 'public' ? { bucketName: getPublicBucketName() } : {})
  } catch (error: any) {
    console.error('S3 delete error:', error)
    throw new Error(`Failed to delete file from storage: ${error.message}`)
  }
}

/**
 * Generate a signed URL for accessing a file in private bucket.
 * `responseParams` (e.g. `response-content-disposition`) are signed into the
 * URL and override the headers S3 sends back for that request.
 */
export async function generateSignedUrl(
  key: string,
  expiresIn: number = SIGNED_URL_EXPIRATION,
  responseParams?: S3ResponseOverrideParams
): Promise<string> {
  try {
    const client = getS3Client()
    const url = await client.presignedGetObject(key, { expirySeconds: expiresIn, responseParams })
    return url
  } catch (error: any) {
    console.error('S3 signed URL generation error:', error)
    throw new Error(`Failed to generate signed URL: ${error.message}`)
  }
}

/**
 * Look up an object in the private bucket. Returns null when it doesn't exist.
 */
export async function statS3Object(key: string): Promise<{ size: number, contentType: string | null } | null> {
  const client = getS3Client()
  try {
    const stat = await client.statObject(key)
    return { size: stat.size, contentType: stat.metadata['Content-Type'] ?? null }
  } catch (error: unknown) {
    if (error instanceof S3Errors.ServerError && error.statusCode === 404) return null
    throw error
  }
}

/**
 * Generate a pre-signed URL for direct browser-to-S3 PUT uploads.
 * Used by features that upload large files (e.g. videos) without proxying
 * the bytes through the Nitro server.
 */
export async function presignedPutUrl(
  key: string,
  _contentType: string,
  expiresIn: number = 3600
): Promise<string> {
  try {
    const client = getS3Client()
    const url = await client.getPresignedUrl('PUT', key, {
      expirySeconds: expiresIn
    })
    return url
  } catch (error: any) {
    console.error('S3 presigned PUT URL generation error:', error)
    throw new Error(`Failed to generate upload URL: ${error.message}`)
  }
}

/**
 * Validate file type for image uploads
 */
export function validateImageType(contentType: string): boolean {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']
  return allowedTypes.includes(contentType)
}

/**
 * Validate file size
 */
export function validateFileSize(fileSize: number, maxSizeMB: number = 5): boolean {
  const maxSize = maxSizeMB * 1024 * 1024
  return fileSize <= maxSize
}
