<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()

interface LogRow {
  id: string
  timestamp: string
  event_type: string
  table_name: string | null
  record_id: string | null
  user_id: string | null
  user_email: string | null
  user_display_name: string | null
  metadata: Record<string, unknown>
}

const logs = ref<LogRow[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const hasMore = ref(true)

const fetchPage = async (reset = false) => {
  if (loading.value) return
  loading.value = true
  try {
    const r = await $fetch<{ logs: LogRow[], nextCursor: string | null }>(
      `/api/o/${orgSlug.value}/audit`,
      { query: reset ? {} : (cursor.value ? { before: cursor.value } : {}) }
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

const formatWhen = (ts: string) => {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}
</script>

<template>
  <div class="max-w-5xl mx-auto">
    <div class="space-y-4">
      <h1 class="text-3xl font-bold">
        Activity log
      </h1>
      <p class="text-sm text-(--ui-text-muted)">
        Audit events scoped to this organization. Host-wide events (login, registration) are not visible here.
      </p>

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
          class="grid grid-cols-[160px_1fr_200px] gap-3 p-3 text-sm items-start"
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
  </div>
</template>
