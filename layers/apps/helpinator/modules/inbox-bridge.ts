import { defineNuxtModule, createResolver } from '@nuxt/kit'
import { defineAlias } from '@nuxtinator/core/kit'

// Points `#helpinator/inbox` at the real inbox adapter when the inbox layer is
// loaded (it registers `#inbox/server` in its nuxt.config, which is merged
// before any module runs), otherwise at a stub that never imports inbox or crm
// — so this layer builds and runs with inbox absent, with handoff disabled.
export default defineNuxtModule({
  meta: { name: 'helpinator/inbox-bridge' },
  setup(_, nuxt) {
    const resolver = createResolver(import.meta.url)
    const hasInbox = Boolean(nuxt.options.alias['#inbox/server'])
    defineAlias(nuxt, {
      '#helpinator/inbox': resolver.resolve(hasInbox ? '../server/bridge/inbox-real.ts' : '../server/bridge/inbox-stub.ts')
    })
  }
})
