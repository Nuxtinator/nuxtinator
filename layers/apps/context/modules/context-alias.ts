import { defineNuxtModule, createResolver } from '@nuxt/kit'
import { defineAlias } from '@nuxtinator/core/kit'

// Registers `#context/server`, the public server API consumer layers import.
// No core fallback: a layer that imports it declares context as a dependency.
export default defineNuxtModule({
  meta: { name: 'context/alias' },
  setup(_, nuxt) {
    const resolver = createResolver(import.meta.url)

    defineAlias(nuxt, {
      '#context/server': resolver.resolve('../server/exports/index.ts')
    })
  }
})
