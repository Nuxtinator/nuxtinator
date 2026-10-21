// Account emails are stored lowercased and looked up with `lower(email)`, so
// an address matches however its letters are cased.
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}
