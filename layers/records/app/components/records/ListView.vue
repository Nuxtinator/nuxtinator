<script setup lang="ts">
// Records list for one type: optional sidebar type switcher, search/status
// filters, sortable table, pagination, and the create modal. List state (q,
// status, sort, dir, page) lives in the URL via useRecordsList. Rendered by
// the records app's type pages and by apps that give a type its own home
// (the crm app's contacts list), which turn the type switcher off.
import type { RecordsTypeFields } from '../../composables/useRecordsTypes'

const props = withDefaults(defineProps<{
  typeKey: string
  /** Show the records type switcher beside the list. */
  switcher?: boolean
}>(), { switcher: true })

const typeKey = computed(() => props.typeKey)
const orgKey = useRecordsOrgKey()

const { types, ensureTypes, getFields } = useRecordsTypes()
const { canManage, ensureAccess } = useRecordsSchemaAdmin()
const recordsPath = useRecordsPath()

const typeInfo = computed(() => types.value.find(t => t.key === typeKey.value) ?? null)
const typeLabel = computed(() => typeInfo.value?.label ?? typeKey.value)
const labelSingular = computed(() => typeInfo.value?.labelSingular ?? 'record')
// Server-evaluated create capability for this type (see RecordsTypeSummary) —
// false hides the create affordances; the POST route enforces it regardless.
const canCreate = computed(() => typeInfo.value?.canCreate ?? false)

// Keyed on the org as well as the type: switching orgs keeps this page
// instance alive (same route record, new orgSlug param), and the caches are
// per-org, so the fetches must re-run.
const fieldSettings = ref<RecordsTypeFields | null>(null)
const fieldsError = ref<string | null>(null)
watch([typeKey, orgKey], async ([key, org]) => {
  ensureTypes().catch(() => {
    // The fields fetch below reports errors; the catalog retries with it.
  })
  ensureAccess()
  fieldSettings.value = null
  fieldsError.value = null
  if (!key) return
  const current = () => key === typeKey.value && org === orgKey.value
  try {
    const res = await getFields(key)
    if (current()) fieldSettings.value = res
  } catch (err) {
    if (current()) fieldsError.value = recordsErrorMessage(err, 'Failed to load record type')
  }
}, { immediate: true })

const {
  items, total, pending, error, page, pageSize,
  q, status, filters, sort, dir, toggleSort, refresh
} = useRecordsList(typeKey)

const statusField = computed(() =>
  fieldSettings.value?.fields.find(f => f.column === 'status') ?? null
)

const sidebarOpen = ref(false)
const { shown: switcherAvailable } = useRecordsSidebar()
const sidebarShown = computed(() => props.switcher && switcherAvailable.value)
const createOpen = ref(false)

const isFiltered = computed(() =>
  q.value !== '' || status.value !== null || Object.keys(filters.value).length > 0
)
const showEmpty = computed(() =>
  !pending.value && total.value === 0 && !isFiltered.value && !error.value && !fieldsError.value
)
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <RecordsSidebar
      v-if="props.switcher"
      v-model:open="sidebarOpen"
    />

    <section
      class="flex-1 flex flex-col min-w-0 border-l-0 border-(--ui-border) overflow-hidden"
      :class="{ 'lg:border-l': sidebarShown }"
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          v-if="sidebarShown"
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open record types"
          @click="sidebarOpen = true"
        />
        <h1 class="flex-1 text-lg font-semibold truncate">
          {{ typeLabel }}
        </h1>
        <UButton
          v-if="canManage && typeInfo"
          icon="i-lucide-settings"
          variant="ghost"
          color="neutral"
          :aria-label="`${typeLabel} settings`"
          title="Settings"
          :to="recordsPath(`/settings/types/${typeKey}`)"
        />
        <UButton
          v-if="canCreate"
          icon="i-lucide-plus"
          @click="createOpen = true"
        >
          New {{ labelSingular.toLowerCase() }}
        </UButton>
      </header>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <RecordsFilters
          v-model:q="q"
          v-model:status="status"
          v-model:filters="filters"
          :status-field="statusField"
          :fields="fieldSettings?.fields ?? []"
        />

        <UAlert
          v-if="fieldsError || error"
          color="error"
          :title="fieldsError || error || 'Something went wrong'"
        />

        <RecordsEmptyState
          v-else-if="showEmpty"
          :type-label="typeLabel"
          :label-singular="labelSingular"
          :can-create="canCreate"
          @create="createOpen = true"
        />

        <template v-else>
          <RecordsTable
            :type-key="typeKey"
            :items="items"
            :fields="fieldSettings?.fields ?? []"
            :loading="pending"
            :sort="sort"
            :dir="dir"
            @toggle-sort="toggleSort"
          />

          <div class="flex items-center justify-between gap-2 flex-wrap">
            <span class="text-sm text-(--ui-text-muted)">
              {{ total }} record{{ total === 1 ? '' : 's' }}
            </span>
            <UPagination
              v-model:page="page"
              :items-per-page="pageSize"
              :total="total"
            />
          </div>
        </template>
      </div>
    </section>

    <RecordsCreateModal
      v-model:open="createOpen"
      :type-key="typeKey"
      :label-singular="labelSingular"
      :fields="fieldSettings?.fields ?? []"
      @created="refresh"
    />
  </div>
</template>
