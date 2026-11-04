import type { H3Event } from 'h3'

// The page that holds the user's account settings (`runtimeConfig.public.accountPath`).
export function getAccountPath(event: H3Event): string {
  return useRuntimeConfig(event).public.accountPath || '/account'
}

// `path` with `params` added to its query. Always same-site: a path that
// normalises to `//host` loses its extra leading slashes.
export function withQueryParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, 'http://local')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return `/${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`
}
