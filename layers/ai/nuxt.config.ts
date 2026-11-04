// AI layer — a shared, optional AI backend any layer can consume, backed by
// OpenRouter's OpenAI-compatible chat-completions API (many models, one API),
// Tinfoil's attested, end-to-end encrypted inference (chat + transcription),
// and OpenAI's and Anthropic's own APIs.
//
// Aliases (registered unconditionally by modules/ai-alias.ts so they win over
// core's fallback):
//   #ai/server — generation (complete/generate with forced tool-calls), the
//                live model list, org/host key + model resolution, and the
//                feature registry, for consumer layers (inbox, context, …).
//   #ai        — client-side shared types for the admin and org AI pages.
//
// Core ships a throwing `#ai/server` fallback so consumers can import
// unconditionally and gate on `isAiConfigured(tx)` when the layer or key is
// absent. Providers are called with plain fetch — no SDKs, so none of the
// `@anthropic-ai/sdk` bundling caveats apply.
//
// Keys, per provider: each org may store its own (encrypted with core's
// NUXT_SECRET_ENCRYPTION_KEY) on its settings page; the host's key is the
// fallback for orgs without one. A host key set in the env wins; otherwise it
// can be stored on Admin → AI.
//
// Host keys (all optional):
//   OPENROUTER_API_KEY
//   TINFOIL_API_KEY
//   OPENAI_API_KEY
//   ANTHROPIC_API_KEY
// Optional:
//   OPENROUTER_BASE_URL  (default https://openrouter.ai/api/v1)
//   AI_HTTP_REFERER      (OpenRouter attribution header)
//   AI_APP_TITLE         (OpenRouter attribution header)
//   OPENAI_BASE_URL      (default https://api.openai.com/v1)
//   ANTHROPIC_BASE_URL   (default https://api.anthropic.com/v1)
//
// Tinfoil (confidential inference in attested enclaves). Its models are
// listed once a Tinfoil key exists:
//   TINFOIL_CATALOG_URL        (default https://api.tinfoil.sh/api/config/models)
//   TINFOIL_USER_CACHE_SECRET  (optional; scopes Tinfoil's prompt cache —
//                               random per process when unset)
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/ai-alias.ts', import.meta.url))
  ],

  // Bundle the Tinfoil SDK and its crypto stack into the server build. Left
  // external, Nitro hoists its @noble/hashes 2.x over the 1.x another
  // dependency needs, and 1.x's self-import then resolves to 2.x and crashes.
  // tinfoil and @tinfoilsh/verifier can also each pull a different
  // @freedomofpress/crypto-browser; left external, the older one lands under
  // .nitro/ with a @noble/hashes 1.x that can't resolve its own self-import.
  nitro: {
    externals: {
      inline: ['tinfoil', 'ehbp', '@tinfoilsh/verifier', 'hpke', '@panva/hpke-noble', '@noble/hashes', '@noble/curves', '@noble/post-quantum',
        '@freedomofpress/crypto-browser', '@freedomofpress/sigstore-browser', '@freedomofpress/tuf-browser']
    }
  },

  runtimeConfig: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    aiHttpReferer: process.env.AI_HTTP_REFERER || '',
    aiAppTitle: process.env.AI_APP_TITLE || '',
    tinfoilApiKey: process.env.TINFOIL_API_KEY || '',
    tinfoilCatalogUrl: process.env.TINFOIL_CATALOG_URL || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || ''
  }
})
