// Org-slug shape validation. Returns a specific human-readable error or null
// if the slug is valid. Mirrored on the client (live form feedback in
// `/orgs/new`) and the server (`POST /api/admin/orgs`, `PATCH /api/o/:slug`,
// etc.) so both layers tell the user the same thing.
//
// The `@` URL prefix on org pages means no slug can collide with a top-level
// system path. Reserved slugs are mail role addresses: a slug can become the
// org's mailbox on a shared inbound domain (inbox slug addresses). The DB also
// enforces shape via the `orgs_slug_shape` CHECK constraint; this validator
// exists for friendlier errors than a raw constraint violation.

export const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/

export const RESERVED_SLUGS = [
  'abuse',
  'bounce',
  'contact',
  'hostmaster',
  'mailer-daemon',
  'no-reply',
  'noreply',
  'notifications',
  'postmaster',
  'security',
  'webmaster'
]

export function validateSlug(slug: string): string | null {
  if (slug.length === 0) {
    return 'Slug is required.'
  }
  if (slug.length < 2) {
    return 'Slug must be at least 2 characters.'
  }
  if (slug.length > 40) {
    return 'Slug must be at most 40 characters.'
  }
  if (slug !== slug.toLowerCase()) {
    return 'Slug must be lowercase. Try "' + slug.toLowerCase() + '".'
  }
  if (!/^[a-z]/.test(slug)) {
    return 'Slug must start with a letter (a–z).'
  }
  // First char OK; check the rest for invalid chars and report the first one.
  const rest = slug.slice(1)
  const bad = rest.match(/[^a-z0-9-]/)
  if (bad) {
    const ch = bad[0]
    if (ch === ' ') return 'Slug cannot contain spaces. Try hyphens instead, e.g. "' + slug.replace(/\s+/g, '-') + '".'
    if (ch === '_') return 'Slug cannot contain underscores. Use hyphens instead, e.g. "' + slug.replace(/_+/g, '-') + '".'
    return `Slug cannot contain "${ch}". Use only lowercase letters, digits, or hyphens.`
  }
  // Belt-and-suspenders: regex still has to pass.
  if (!SLUG_RE.test(slug)) {
    return 'Slug must be 2–40 lowercase letters, digits, or hyphens, starting with a letter.'
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return `"${slug}" is reserved. Choose another slug.`
  }
  return null
}
