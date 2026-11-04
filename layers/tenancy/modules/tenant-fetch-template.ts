import { defineNuxtModule, useLogger } from '@nuxt/kit'

// Nuxt auto-imports `$fetch` from a generated `fetch.mjs` template that
// creates the ofetch instance and exports it as a static binding, so
// replacing `globalThis.$fetch` at runtime never reaches component code.
// This module rewrites that template so the instance itself injects
// `X-Active-Org` on relative `/api/*` requests. The slug is parsed from the
// page URL (`/@<slug>/...`) rather than read from the router, which is stale
// for layout-level components until the page has finished rendering.
const FETCH_TEMPLATE = `
import { $fetch as _$fetch } from 'ofetch'
import { baseURL } from '#internal/nuxt/paths'

const ORG_PATH_RE = /^\\/@([^/]+)(?:\\/|$)/

function activeOrgSlug() {
  if (typeof window === 'undefined') return null
  const match = ORG_PATH_RE.exec(window.location.pathname)
  return match ? decodeURIComponent(match[1]) : null
}

function withOrgHeader(request, options) {
  if (typeof request !== 'string' || !request.startsWith('/api/')) return options
  const slug = activeOrgSlug()
  if (!slug) return options
  const headers = new Headers(options?.headers)
  if (!headers.has('x-active-org')) headers.set('x-active-org', slug)
  return { ...(options ?? {}), headers }
}

function wrap(base) {
  const wrapped = (request, options) => base(request, withOrgHeader(request, options))
  wrapped.raw = (request, options) => base.raw(request, withOrgHeader(request, options))
  wrapped.native = base.native
  wrapped.create = (defaults, globalOptions) => wrap(base.create(defaults, globalOptions))
  return wrapped
}

if (!globalThis.$fetch) {
  globalThis.$fetch = wrap(_$fetch.create({ baseURL: baseURL() }))
}
export const $fetch = globalThis.$fetch
`.trimStart()

export default defineNuxtModule({
  meta: { name: 'tenancy/fetch-template' },
  setup(_, nuxt) {
    nuxt.hook('app:templates', (app) => {
      const index = app.templates.findIndex(t => t.filename === 'fetch.mjs')
      if (index === -1) {
        useLogger('tenancy').warn('Nuxt `fetch.mjs` template not found; `$fetch` will not inject X-Active-Org.')
        return
      }
      app.templates[index] = { ...app.templates[index], getContents: () => FETCH_TEMPLATE }
    })
  }
})
