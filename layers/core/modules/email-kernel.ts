import { defineNuxtModule, createResolver } from '@nuxt/kit'
import { defineAlias } from '../kit/alias'

// Points `#email` at core's implementation on the mail kernel, unless another
// module has already set it. Same pattern as `modules/tenant-kernel.ts`.
export default defineNuxtModule({
  meta: { name: 'email-kernel' },
  setup(_, nuxt) {
    if (nuxt.options.alias['#email']) return

    const resolver = createResolver(import.meta.url)
    defineAlias(nuxt, { '#email': resolver.resolve('../email-kernel/email.ts') })
  }
})
