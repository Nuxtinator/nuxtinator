// A person's two initials for an avatar without an image: first and last
// name, else the first two letters of the only name (or of the email).
export function userInitials(name: string | null | undefined, email?: string | null): string {
  const source = (name || email || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}
