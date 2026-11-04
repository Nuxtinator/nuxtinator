// Registers the `#context/server` alias: the public server API for consumer layers.
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/context-alias.ts', import.meta.url))
  ],
  runtimeConfig: {
    // The section vector index needs pgvector. Without it core's migration
    // runner holds back these two migrations and the layer runs unindexed.
    migrationRequiredExtensions: { context_013: ['vector'], context_T013: ['vector'] }
  }
})
