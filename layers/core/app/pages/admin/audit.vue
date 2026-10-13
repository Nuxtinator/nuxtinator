<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const toast = useToast()

interface AdminOrg {
  id: string
  slug: string
  name: string
}

interface LogRow {
  id: string
  timestamp: string
  event_type: string
  table_name: string | null
  record_id: string | null
  user_id: string | null
  org_id: string | null
  user_email: string | null
  user_display_name: string | null
  org_slug: string | null
  org_name: string | null
  metadata: Record<string, unknown>
}

// The org-scope filter is multi-tenant only — `/api/admin/orgs` exists when the
// tenancy layer is loaded. In single-tenant mode every log is host-global, so
// skip the fetch and hide the filter.
const tenancyEnabled = computed(() => useRuntimeConfig().public.tenancy === true)

const { data: orgsData } = tenancyEnabled.value
  ? await useFetch<{ orgs: AdminOrg[] }>('/api/admin/orgs', { default: () => ({ orgs: [] }) })
  : { data: ref({ orgs: [] as AdminOrg[] }) }
const orgs = computed(() => orgsData.value?.orgs ?? [])

type Scope = 'all' | 'host' | string
const scope = ref<Scope>('all')

const logs = ref<LogRow[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const hasMore = ref(true)

const fetchPage = async (reset = false) => {
  if (loading.value) return
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (!reset && cursor.value) params.before = cursor.value
    if (scope.value === 'host') params.hostOnly = '1'
    else if (scope.value !== 'all') params.orgId = scope.value

    const r = await $fetch<{ logs: LogRow[], nextCursor: string | null }>(
      '/api/admin/audit',
      { query: params }
    )
    if (reset) logs.value = r.logs
    else logs.value = [...logs.value, ...r.logs]
    cursor.value = r.nextCursor
    hasMore.value = !!r.nextCursor
  } catch (err: unknown) {
    toast.add({
      title: 'Failed to load logs',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

await fetchPage(true)

watch(scope, async () => {
  cursor.value = null
  await fetchPage(true)
})

const formatWhen = (ts: string) => {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-bold">
      Activity log
    </h1>

    <div
      v-if="tenancyEnabled"
      class="flex flex-wrap gap-2"
    >
      <UButton
        :variant="scope === 'all' ? 'solid' : 'outline'"
        size="sm"
        @click="scope = 'all'"
      >
        All
      </UButton>
      <UButton
        :variant="scope === 'host' ? 'solid' : 'outline'"
        size="sm"
        @click="scope = 'host'"
      >
        Host-only
      </UButton>
      <UButton
        v-for="o in orgs"
        :key="o.id"
        :variant="scope === o.id ? 'solid' : 'outline'"
        size="sm"
        @click="scope = o.id"
      >
        {{ o.name }}
      </UButton>
    </div>

    <div
      v-if="logs.length === 0 && !loading"
      class="text-sm text-(--ui-text-muted) p-6 border border-(--ui-border) rounded-md"
    >
      No activity yet.
    </div>

    <ul
      v-else
      class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
    >
      <li
        v-for="row in logs"
        :key="row.id"
        class="grid grid-cols-[160px_1fr_140px_180px] gap-3 p-3 text-sm items-start"
      >
        <div class="text-(--ui-text-muted) font-mono text-xs whitespace-nowrap">
          {{ formatWhen(row.timestamp) }}
        </div>
        <div class="min-w-0">
          <div class="font-mono">
            {{ row.event_type }}
          </div>
          <div
            v-if="row.table_name"
            class="text-xs text-(--ui-text-muted)"
          >
            {{ row.table_name }}<span v-if="row.record_id">·{{ row.record_id }}</span>
          </div>
          <pre
            v-if="row.metadata && Object.keys(row.metadata).length > 0"
            class="text-xs text-(--ui-text-muted) mt-1 whitespace-pre-wrap break-all"
          >{{ JSON.stringify(row.metadata) }}</pre>
        </div>
        <div class="text-xs text-(--ui-text-muted) truncate">
          {{ row.org_name || (row.org_id ? '?' : '—') }}
        </div>
        <div class="text-xs text-(--ui-text-muted) truncate">
          {{ row.user_display_name || row.user_email || '—' }}
        </div>
      </li>
    </ul>

    <div
      v-if="hasMore"
      class="flex justify-center"
    >
      <UButton
        :loading="loading"
        variant="outline"
        @click="() => fetchPage(false)"
      >
        Load more
      </UButton>
    </div>
  </div>
</template>
