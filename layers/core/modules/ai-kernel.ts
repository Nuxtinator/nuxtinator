import { defineNuxtModule, createResolver } from '@nuxt/kit'
import { defineAlias } from '../kit/alias'

// Registers `#ai/server` as a throwing fallback only if no other module (the
// `@nuxtinator/ai` layer's alias module) has already set it. Same pattern as
// modules/email-kernel.ts — the layer that provides the real implementation
// sets the alias unconditionally and wins; this fallback fills the gap so
// consumers can import `#ai/server` and gate on `isAiConfigured(tx)` regardless.
export default defineNuxtModule({
  meta: { name: 'ai-kernel' },
  setup(_, nuxt) {
    if (nuxt.options.alias['#ai/server']) return

    const resolver = createResolver(import.meta.url)
    const fallbackPath = resolver.resolve('../ai-fallback/ai.ts')

    defineAlias(nuxt, { '#ai/server': fallbackPath })
  }
})
