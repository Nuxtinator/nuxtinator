// Browsers scope cookies by hostname, not port, so apps sharing a host (e.g.
// several dev servers on localhost) need distinct names: NUXT_PUBLIC_COOKIE_PREFIX.
export function cookieName(name: string): string {
  return `${useRuntimeConfig().public.cookiePrefix || ''}${name}`
}
