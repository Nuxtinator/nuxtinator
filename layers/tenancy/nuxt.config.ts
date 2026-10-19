import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/tenant-kernel.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/tenant-pages-extend.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/tenant-fetch-template.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/tenant-migrations.ts', import.meta.url)),
    fileURLToPath(new URL('./modules/tenant-mcp.ts', import.meta.url))
  ],

  alias: {
    '#tenant/admin-db': fileURLToPath(new URL('./server/utils/database-admin.ts', import.meta.url))
  },

  // Mirror the kernel-alias paths into Nitro's tsConfig so server-side type
  // resolution picks up the multi-mode kernel.
  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#tenant': [`${layerRoot}app/utils/tenant.ts`],
            '#tenant/server': [`${layerRoot}server/utils/tenant.ts`],
            '#tenant/admin-db': [`${layerRoot}server/utils/database-admin.ts`]
          }
        }
      }
    }
  },

  runtimeConfig: {
    // Symmetric encryption key for the OAuth `state` parameter, used by
    // `encodeFlowOrg` / `decodeFlowOrg` to bind the active org to OAuth flows.
    tenantFlowSecret: process.env.NUXT_TENANT_FLOW_SECRET || ''
  }
})
