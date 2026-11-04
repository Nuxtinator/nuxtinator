// Shared state for the portfolio assistant: whether the panel is open, which
// scope it works in, and which conversation is selected. The launcher and the
// panel both read it, so it lives in `useState` rather than component state.
//
// The scope is derived from the route: a section page offers section,
// portfolio, and all; a portfolio page offers portfolio and all; the list page
// only all. When navigation removes the current scope the most specific one
// still available is selected.
import { useActiveOrg } from '#tenant'

export type AssistantScopeKind = 'section' | 'portfolio' | 'all'

export const CONTEXT_ASSISTANT_FEATURE = 'context.assistant'

export type AssistantProposalStatus = 'pending' | 'applied' | 'rejected'

export interface AssistantProposal {
  portfolio_slug: string
  portfolio_name: string
  section_key: string
  section_title: string
  current_content: string
  proposed_content: string
  status: AssistantProposalStatus
}

export interface AssistantMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  proposals: AssistantProposal[]
  context_loaded: string[]
  created_at: string
}

export interface AssistantConversation {
  id: string
  portfolio_id: string | null
  section_key: string | null
  title: string
  created_at: string
  updated_at: string
  portfolio_slug?: string | null
  portfolio_name?: string | null
  message_count?: number
}

export interface AssistantScopeTarget {
  portfolio: string | null
  section: string | null
}

function paramString(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].length > 0) return raw[0]
  return null
}

export function useContextAssistant() {
  const route = useRoute()
  const open = useState<boolean>('context-assistant.open', () => false)
  const scope = useState<AssistantScopeKind>('context-assistant.scope', () => 'all')
  const conversationId = useState<string | null>('context-assistant.conversation', () => null)

  const routeSlug = computed(() => paramString(route.params.slug))
  const routeKey = computed(() => paramString(route.params.key))

  const availableScopes = computed<AssistantScopeKind[]>(() => [
    ...(routeKey.value ? ['section' as const] : []),
    ...(routeSlug.value ? ['portfolio' as const] : []),
    'all'
  ])
  const defaultScope = computed<AssistantScopeKind>(() =>
    routeKey.value ? 'section' : routeSlug.value ? 'portfolio' : 'all'
  )

  watch(availableScopes, (avail) => {
    if (!avail.includes(scope.value)) scope.value = defaultScope.value
  })

  const target = computed<AssistantScopeTarget>(() => ({
    portfolio: scope.value === 'all' ? null : routeSlug.value,
    section: scope.value === 'section' ? routeKey.value : null
  }))
  const targetKey = computed(() => `${target.value.portfolio ?? ''}|${target.value.section ?? ''}`)

  function openPanel() {
    scope.value = defaultScope.value
    open.value = true
  }

  return { open, scope, conversationId, routeSlug, routeKey, availableScopes, defaultScope, target, targetKey, openPanel }
}

// Whether the assistant can run: the AI layer is loaded, a key is present, and
// a model is enabled for the feature in the active org.
export function useContextAssistantStatus() {
  const { slug: orgSlug } = useActiveOrg()
  const available = useState<boolean>('context-assistant.available', () => false)

  async function refresh() {
    try {
      const url: string = `/api/ai/status?feature=${encodeURIComponent(CONTEXT_ASSISTANT_FEATURE)}`
      const status = await $fetch<{ featureAvailable: boolean }>(url)
      available.value = status.featureAvailable
    } catch {
      available.value = false
    }
  }

  watch(orgSlug, () => refresh(), { immediate: true })

  return { available, refresh }
}
