import { addServerPlugin, defineNuxtModule } from '@nuxt/kit'
import { fileURLToPath } from 'node:url'

// Registers the tenancy layer's MCP tools when the MCP layer is loaded too.
// They live outside `server/` so deploys without MCP never compile or
// typecheck their `#mcp-layer` import; with MCP they join the server tsconfig.
export default defineNuxtModule({
  meta: { name: 'tenancy/mcp' },
  setup(_, nuxt) {
    if (!nuxt.options.alias['#mcp-layer']) return
    const mcpDir = fileURLToPath(new URL('../mcp', import.meta.url))
    addServerPlugin(`${mcpDir}/list-orgs.ts`)
    nuxt.hook('nitro:config', (config) => {
      config.typescript ??= {}
      config.typescript.tsConfig ??= {}
      config.typescript.tsConfig.include = [...(config.typescript.tsConfig.include ?? []), `${mcpDir}/**/*`]
    })
  }
})
