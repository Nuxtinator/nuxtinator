// The accessible-views list (landing page + sidebar) and view creation.
// Grouping is presentation: "mine" = I own it, everything else splits by
// how it reached me (a direct share vs. org-wide visibility).

import type {
  WorkflowsViewDetail,
  WorkflowsViewSummary,
  WorkflowsViewType,
  WorkflowsVisibility
} from '../utils/workflows-types'

export interface WorkflowsCreateInput {
  name: string
  icon?: string
  recordTypeKey: string
  viewType: WorkflowsViewType
  visibility?: WorkflowsVisibility
  definition?: Record<string, unknown>
}

export function useWorkflowsViews() {
  const { user } = useAuth()
  const items = useState<WorkflowsViewSummary[]>('workflows:views', () => [])
  const pending = ref(false)
  const error = ref<string | null>(null)

  let requestId = 0
  async function refresh(): Promise<void> {
    const id = ++requestId
    pending.value = true
    try {
      const res = await $fetch<{ items: WorkflowsViewSummary[] }>('/api/workflows/views')
      if (id !== requestId) return
      items.value = res.items
      error.value = null
    } catch (err) {
      if (id !== requestId) return
      error.value = crmErrorMessage(err, 'Failed to load views')
    } finally {
      if (id === requestId) pending.value = false
    }
  }

  const myId = computed<string | null>(() => (user.value as { id?: string } | null)?.id ?? null)
  const mine = computed(() => items.value.filter(v => v.ownerId === myId.value))
  const sharedWithMe = computed(() =>
    items.value.filter(v => v.ownerId !== myId.value && v.visibility === 'shared'))
  const orgWide = computed(() =>
    items.value.filter(v => v.ownerId !== myId.value && v.visibility === 'org'))

  async function create(input: WorkflowsCreateInput): Promise<WorkflowsViewDetail> {
    const created = await $fetch<WorkflowsViewDetail>('/api/workflows/views', {
      method: 'POST',
      body: input
    })
    await refresh()
    return created
  }

  return { items, pending, error, refresh, mine, sharedWithMe, orgWide, create }
}
