// Display metadata for each version provenance key. The DB stores only the
// key; labels and icons resolve here.
import type { ContextSectionVersionSource } from '../../server/database/schema'

export type ContextVersionSource = ContextSectionVersionSource

export const CONTEXT_VERSION_SOURCES = {
  user: { label: 'Direct edit', icon: 'i-lucide-pencil', color: 'neutral' },
  assistant: { label: 'AI assistant', icon: 'i-lucide-sparkles', color: 'primary' },
  mcp: { label: 'AI via MCP', icon: 'i-lucide-plug', color: 'primary' },
  suggestion: { label: 'Approved suggestion', icon: 'i-lucide-git-pull-request-arrow', color: 'primary' }
} as const satisfies Record<ContextVersionSource, { label: string, icon: string, color: 'neutral' | 'primary' }>
