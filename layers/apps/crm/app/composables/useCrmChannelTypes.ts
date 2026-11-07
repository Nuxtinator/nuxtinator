// Client wrapper for the merged channel-type catalog and its admin routes,
// cached per org (useRecordsOrgKey) in useState so the schema builder's
// channel-type picker and the settings list share one copy.

export type CrmChannelValueFormat = 'email' | 'phone' | 'handle' | 'url' | 'freeform'

/** A channel type as served by GET /api/crm/schema/channel-types. */
export interface CrmChannelTypeSummary {
  key: string
  label: string
  icon: string | null
  valueFormat: CrmChannelValueFormat
  custom: boolean
}

export interface CrmCreateChannelTypeInput {
  typeKey: string
  label: string
  valueFormat: CrmChannelValueFormat
  icon?: string
}

export function useCrmChannelTypes() {
  const cache = useState<Record<string, CrmChannelTypeSummary[]>>('crm:channel-types', () => ({}))
  const orgKey = useRecordsOrgKey()

  const channelTypes = computed(() => cache.value[orgKey.value] ?? [])

  // The org is captured before the request so a response that resolves after
  // an org switch lands in the slot it was fetched for.
  async function loadChannelTypes(): Promise<void> {
    const key = orgKey.value
    const res = await $fetch<{ channelTypes: CrmChannelTypeSummary[] }>('/api/crm/schema/channel-types')
    cache.value = { ...cache.value, [key]: res.channelTypes }
  }

  async function createChannelType(input: CrmCreateChannelTypeInput): Promise<CrmChannelTypeSummary> {
    const res = await $fetch<{ channelType: CrmChannelTypeSummary }>('/api/crm/schema/channel-types', {
      method: 'POST',
      body: input
    })
    await loadChannelTypes()
    return res.channelType
  }

  async function deleteChannelType(typeKey: string): Promise<void> {
    await $fetch(`/api/crm/schema/channel-types/${typeKey}`, { method: 'DELETE' })
    await loadChannelTypes()
  }

  return { channelTypes, loadChannelTypes, createChannelType, deleteChannelType }
}
