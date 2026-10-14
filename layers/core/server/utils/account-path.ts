import type { H3Event } from 'h3'

// The page that holds the user's account settings (`runtimeConfig.public.accountPath`).
export function getAccountPath(event: H3Event): string {
  return useRuntimeConfig(event).public.accountPath || '/account'
}

// A same-site path with `params` set in its query string, keeping any query it already has.
export function withQueryParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, 'http://local')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return `${url.pathname}${url.search}${url.hash}`
}
