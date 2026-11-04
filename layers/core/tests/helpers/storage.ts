// Mirrors the server's isPublicStorageConfigured, from the same env vars, so
// tests can tell which upload path the server takes.
export function publicStorageConfigured(): boolean {
  const env = process.env
  return !!(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET_NAME && env.S3_PUBLIC_BASE_URL)
}
