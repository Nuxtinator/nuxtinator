import { zodToJsonSchema } from 'zod-to-json-schema'
import { isPermission } from '#core/app/utils/permissions'
import { isRegisteredPermission } from '#core/server/utils/permissions-registry'
import { registerScope } from '#oauth/scopes'
import type { McpToolDef, McpResourceDef } from './define'

// A scope is acceptable if it's in the host's static PERMISSIONS array OR
// has been registered at runtime by a layer's `registerPermissions(...)`
// plugin. Layer-supplied permissions only show up in the runtime registry,
// so checking just `isPermission` would reject any tool whose scope comes
// from a layer (e.g. `messages.read`).
function isAcceptableScope(scope: string): boolean {
  return isPermission(scope) || isRegisteredPermission(scope)
}

export interface RegisteredTool {
  def: McpToolDef
  inputJsonSchema: Record<string, unknown>
  outputJsonSchema?: Record<string, unknown>
}

export interface RegisteredResource {
  def: McpResourceDef
}

export interface McpRegistry {
  readonly tools: ReadonlyArray<RegisteredTool>
  readonly resources: ReadonlyArray<RegisteredResource>
  // Generics are wide-open so callers can register tools whose Zod schemas
  // inferred narrower I/O types. The registry treats every tool uniformly
  // once stored — narrow I/O is preserved on the def for the dispatcher.
  register: <I, O>(tool: McpToolDef<I, O>) => void
  registerResource: (resource: McpResourceDef) => void
  __resetForTests: () => void
}

// Module-level singleton. The registry is a per-process value, so backing
// `nitroApp.mcpRegistry` with a module-level singleton lets consumer
// plugins call `register(...)` regardless of plugin-load order across
// layers (Nuxt's layer→consumer plugin ordering isn't strictly defined
// for cross-layer cases). The 00-mcp-init.ts plugin still does boot-time
// validation; it just doesn't *create* the registry anymore — it ensures
// `nitroApp.mcpRegistry` points at the singleton.
let _singleton: McpRegistry | null = null

export function getRegistry(): McpRegistry {
  if (!_singleton) {
    _singleton = createRegistry()
  }
  return _singleton
}

function projectSchema(schema: unknown): Record<string, unknown> {
  return zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'jsonSchema7',
    $refStrategy: 'none'
  }) as Record<string, unknown>
}

export function createRegistry(): McpRegistry {
  const tools: RegisteredTool[] = []
  const resources: RegisteredResource[] = []
  const toolsByName = new Map<string, number>()

  function register<I, O>(tool: McpToolDef<I, O>): void {
    if (tool.scope !== undefined && !isAcceptableScope(tool.scope)) {
      throw new Error(
        `MCP tool "${tool.name}" declares scope "${tool.scope}" which is not in the project's PERMISSIONS list. `
        + `Add it to app/utils/permissions.ts or fix the tool definition.`
      )
    }

    const inputJsonSchema = projectSchema(tool.input)
    // The MCP spec requires a tool's inputSchema to be a JSON Schema object.
    // A top-level z.union() (bare anyOf) or similar wrapper erases the object
    // type, and strict clients (Claude Code) reject the server's ENTIRE tool
    // list over one bad tool — fail loudly at boot instead.
    if (inputJsonSchema.type !== 'object') {
      throw new Error(
        `MCP tool "${tool.name}" input must project to a JSON Schema object `
        + `(got type: ${JSON.stringify(inputJsonSchema.type)}). Use a single z.object() `
        + `input and validate variants in the handler.`
      )
    }
    const outputJsonSchema = tool.output ? projectSchema(tool.output) : undefined
    const entry: RegisteredTool = { def: tool as McpToolDef, inputJsonSchema, outputJsonSchema }

    const existingIndex = toolsByName.get(tool.name)
    if (existingIndex !== undefined) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`MCP tool "${tool.name}" registered twice. Names must be unique.`)
      }
      // Dev: replace prior registration so HMR works without a server restart.
      console.info(`[mcp-layer] Replacing duplicate tool registration: ${tool.name}`)
      tools[existingIndex] = entry
      if (tool.scope) registerScope(tool.scope)
      return
    }

    tools.push(entry)
    toolsByName.set(tool.name, tools.length - 1)
    // Feed the OAuth-layer scope registry so /.well-known/* discovery
    // and the DCR explicit-scope ceiling pick up this tool's scope
    // without the consumer having to enumerate it in nuxt.config.
    if (tool.scope) registerScope(tool.scope)
  }

  function registerResource(resource: McpResourceDef): void {
    if (!isAcceptableScope(resource.scope)) {
      throw new Error(
        `MCP resource "${resource.uriPattern}" declares scope "${resource.scope}" which is not in the project's PERMISSIONS list.`
      )
    }
    resources.push({ def: resource })
    registerScope(resource.scope)
  }

  function __resetForTests(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('__resetForTests is not callable in production')
    }
    tools.length = 0
    resources.length = 0
    toolsByName.clear()
  }

  return {
    get tools() {
      return tools
    },
    get resources() {
      return resources
    },
    register,
    registerResource,
    __resetForTests
  }
}
