<script setup lang="ts">
// Search + filter bar for the list page. `q` and `status` bind to the
// URL-backed list state; the search input debounces before writing so
// typing doesn't fire a request per keystroke. The status select appears
// only when the type has a status field. Other filterable kinds — boolean,
// key_select, multi_select, date, datetime, user_select — are added as
// chips from the Filter menu; their values live in the URL-backed `filters`
// object as list-engine operator shapes ({ in }, { gte, lte }, or a bare
// boolean for equality).
import type { DropdownMenuItem } from '@nuxt/ui'
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  statusField: RecordsFieldSetting | null
  fields: RecordsFieldSetting[]
}>()

const q = defineModel<string>('q', { default: '' })
const status = defineModel<string | null>('status', { default: null })
const filters = defineModel<Record<string, unknown>>('filters', { default: () => ({}) })

const search = ref(q.value)
watch(q, (v) => {
  if (v !== search.value) search.value = v
})

let timer: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    q.value = v
  }, 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

interface StatusItem {
  label: string
  value: string | null
}

const statusItems = computed<StatusItem[]>(() => {
  const options = props.statusField?.options
  if (!options) return []
  return [
    { label: 'All statuses', value: null },
    ...Object.entries(options)
      .filter(([, opt]) => !opt.deleted)
      .map(([key, opt]) => ({ label: opt.label, value: key as string | null }))
  ]
})

// --- kind-aware filter chips -----------------------------------------------

const FILTERABLE_KINDS = new Set(['boolean', 'key_select', 'multi_select', 'date', 'datetime', 'user_select'])

// Promoted columns are excluded — status already has its own select.
const filterableFields = computed(() =>
  props.fields.filter(f => !f.hidden && !f.orphan && !f.column && FILTERABLE_KINDS.has(f.kind))
)

// Chips stay open while empty (just added from the menu); a chip without a
// value writes nothing to the filters object.
const activeKeys = ref<string[]>([])
watch(filters, (v) => {
  for (const key of Object.keys(v)) {
    if (!activeKeys.value.includes(key)) activeKeys.value.push(key)
  }
}, { immediate: true })

const activeFields = computed(() =>
  activeKeys.value
    .map(key => filterableFields.value.find(f => f.key === key))
    .filter((f): f is RecordsFieldSetting => f !== undefined)
)

const menuItems = computed<DropdownMenuItem[]>(() =>
  filterableFields.value
    .filter(f => !activeKeys.value.includes(f.key))
    .map(f => ({ label: f.label, onSelect: () => activeKeys.value.push(f.key) }))
)

const { users, ensureUsers } = useRecordsUsers()
watch(activeFields, (list) => {
  if (list.some(f => f.kind === 'user_select')) {
    ensureUsers().catch(() => {
      // An empty picker communicates the failure.
    })
  }
}, { immediate: true })

const userItems = computed(() => users.value.map(u => ({ label: u.name, value: u.id })))

const booleanItems = [
  { label: 'Any', value: null },
  { label: 'Yes', value: true },
  { label: 'No', value: false }
]

function setFilter(key: string, value: unknown | undefined) {
  const next = { ...filters.value }
  if (value === undefined) delete next[key]
  else next[key] = value
  filters.value = next
}

function removeChip(key: string) {
  activeKeys.value = activeKeys.value.filter(k => k !== key)
  setFilter(key, undefined)
}

function optionItems(field: RecordsFieldSetting) {
  return Object.entries(field.options ?? {})
    .filter(([, opt]) => !opt.deleted)
    .map(([key, opt]) => ({ label: opt.label, value: key }))
}

function inValue(key: string): string[] {
  const raw = filters.value[key]
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { in?: unknown[] }).in)) {
    return (raw as { in: unknown[] }).in.map(String)
  }
  return []
}

function setIn(key: string, values: string[]) {
  setFilter(key, values.length > 0 ? { in: values } : undefined)
}

function boolValue(key: string): boolean | null {
  const raw = filters.value[key]
  return typeof raw === 'boolean' ? raw : null
}

function setBool(key: string, value: boolean | null) {
  setFilter(key, value === null ? undefined : value)
}

function rangeValue(key: string, bound: 'gte' | 'lte'): string {
  const raw = filters.value[key]
  if (raw !== null && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[bound]
    if (typeof v === 'string') return v.slice(0, 10)
  }
  return ''
}

function setRange(key: string, bound: 'gte' | 'lte', value: string) {
  const raw = filters.value[key]
  const next = raw !== null && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  if (value === '') delete next[bound]
  else next[bound] = value
  setFilter(key, Object.keys(next).length > 0 ? next : undefined)
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-col sm:flex-row gap-2">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search..."
        class="flex-1"
      />
      <USelectMenu
        v-if="statusField"
        v-model="status"
        :items="statusItems"
        value-key="value"
        label-key="label"
        placeholder="Status"
        class="sm:w-48"
      />
      <UDropdownMenu
        v-if="menuItems.length > 0"
        :items="menuItems"
      >
        <UButton
          icon="i-lucide-list-filter"
          variant="outline"
          color="neutral"
        >
          Filter
        </UButton>
      </UDropdownMenu>
    </div>

    <div
      v-if="activeFields.length > 0"
      class="flex flex-wrap items-center gap-2"
    >
      <div
        v-for="field in activeFields"
        :key="field.key"
        class="flex items-center gap-1.5 border border-(--ui-border) rounded-lg pl-2.5 pr-1 py-1 bg-(--ui-bg)"
      >
        <span class="text-xs text-(--ui-text-muted)">{{ field.label }}</span>

        <USelectMenu
          v-if="field.kind === 'key_select' || field.kind === 'multi_select'"
          :model-value="inValue(field.key)"
          :items="optionItems(field)"
          multiple
          value-key="value"
          label-key="label"
          size="xs"
          placeholder="Any"
          class="w-36"
          @update:model-value="setIn(field.key, $event)"
        />

        <USelectMenu
          v-else-if="field.kind === 'user_select'"
          :model-value="inValue(field.key)"
          :items="userItems"
          multiple
          value-key="value"
          label-key="label"
          size="xs"
          placeholder="Anyone"
          class="w-40"
          @update:model-value="setIn(field.key, $event)"
        />

        <USelectMenu
          v-else-if="field.kind === 'boolean'"
          :model-value="boolValue(field.key)"
          :items="booleanItems"
          value-key="value"
          label-key="label"
          size="xs"
          placeholder="Any"
          class="w-24"
          @update:model-value="setBool(field.key, $event)"
        />

        <template v-else-if="field.kind === 'date' || field.kind === 'datetime'">
          <UInput
            :model-value="rangeValue(field.key, 'gte')"
            type="date"
            size="xs"
            aria-label="From date"
            class="w-36"
            @change="setRange(field.key, 'gte', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-xs text-(--ui-text-muted)">–</span>
          <UInput
            :model-value="rangeValue(field.key, 'lte')"
            type="date"
            size="xs"
            aria-label="To date"
            class="w-36"
            @change="setRange(field.key, 'lte', ($event.target as HTMLInputElement).value)"
          />
        </template>

        <UButton
          icon="i-lucide-x"
          variant="ghost"
          color="neutral"
          size="xs"
          :aria-label="`Remove ${field.label} filter`"
          @click="removeChip(field.key)"
        />
      </div>
    </div>
  </div>
</template>
