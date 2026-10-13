import type { ZodSchema } from 'zod'
import type { H3Event } from 'h3'
// Cross-layer type import to the OAuth layer; see mcp-origin.ts for why we
// use the `#oauth/*` aliases declared in the OAuth layer's nuxt.config.ts
// instead of `~~/...` or `#imports`.
import type { BearerAuth } from '#oauth/bearer'
import type { Permission } from '#core/app/utils/permissions'

// Optional per-tool rate-limit override. Layered on top of the default buckets.
export interface McpToolRateLimit {
  limit: number
  windowMs: number
  keyBy: 'token' | 'user' | 'global'
}

// Shared base — what every dispatch path provides.
export interface McpDispatchContext {
  auth: BearerAuth
  event: H3Event
  userPermissions: ReadonlySet<Permission>
}

export interface McpToolContext extends McpDispatchContext {
  // Accepts any McpToolDef regardless of inferred I/O generics — the
  // dispatcher and audit helpers only read name/scope/description, never
  // the typed input or output payload through this back-reference.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: McpToolDef<any, any>
}

export interface McpResourceContext extends McpDispatchContext {
  resource: McpResourceDef
}

export interface McpToolResult<O = unknown> {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: O
  isError?: boolean
}

export interface McpToolDef<I = unknown, O = unknown> {
  name: string
  // What people see the tool called, e.g. "Move Card"; sent as the MCP
  // tool `title`.
  title?: string
  description: string
  scope: Permission
  destructive?: boolean
  input: ZodSchema<I>
  output?: ZodSchema<O>
  rateLimit?: McpToolRateLimit
  handler: (input: I, ctx: McpToolContext) => Promise<McpToolResult<O>>
}

export interface McpResourceListItem {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpResourceReadContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpResourceReadResult {
  contents: McpResourceReadContent[]
}

export interface McpResourceDef {
  uriPattern: string
  scope: Permission
  list: (ctx: McpResourceContext) => Promise<McpResourceListItem[]>
  read: (uri: string, ctx: McpResourceContext) => Promise<McpResourceReadResult>
}

// Authorization-failure shape (clients can handle isError programmatically).
export type McpAuthorizationError =
  | { error: 'insufficient_scope'; required: Permission; surface: 'token'; actionable: 're_authorize' }
  | { error: 'insufficient_permission'; required: Permission; surface: 'rbac'; actionable: 'contact_admin' }

export function defineMcpTool<I, O>(def: McpToolDef<I, O>): McpToolDef<I, O> {
  return def
}

export function defineMcpResource(def: McpResourceDef): McpResourceDef {
  return def
}

// Re-export from OAuth layer so consumers don't have to know about the cross-layer path.
export type { BearerAuth }
