<script setup lang="ts">
// The view's filter surface, two tiers reusing the records filter chips:
//
// - Personal (everyone): search + chips held in session state only — they
//   overlay the saved filters per key for this caller and vanish on reload.
// - Saved (edit access): the view definition's shared filters and default
//   sort, editable in a collapsible section; every change persists for every
//   viewer. The active sort shows as a badge for everyone.
//
// Status rides inside each filters object as a bare equality on the
// intrinsic `status` key; the computed adapters below split it out for
// RecordFilters' separate status model.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewDetail } from '../../utils/views-types'

const props = defineProps<{
  view: ViewDetail
  fields: RecordsFieldSetting[]
  canEditDefinition: boolean
}>()

const q = defineModel<string>('q', { default: '' })
const personalFilters = defineModel<Record<string, unknown>>('personalFilters', { default: () => ({}) })

const emit = defineEmits<{
  definitionFilters: [filters: Record<string, unknown>]
  definitionSort: [sort: { field: string, dir: 'asc' | 'desc' } | null]
}>()

const statusField = computed(() =>
  props.fields.find(f => f.column === 'status') ?? null)

function splitStatus(
  read: () => Record<string, unknown>,
  write: (next: Record<string, unknown>) => void
) {
  const status = computed<string | null>({
    get: () => {
      const v = read().status
      return typeof v === 'string' ? v : null
    },
    set: (v) => {
      const next = { ...read() }
      if (v) next.status = v
      else delete next.status
      write(next)
    }
  })
  const rest = computed<Record<string, unknown>>({
    get: () => {
      const { status: _, ...others } = read()
      return others
    },
    set: (v) => {
      const current = read()
      const next: Record<string, unknown> = { ...v }
      if (typeof current.status === 'string') next.status = current.status
      write(next)
    }
  })
  return { status, rest }
}

const personal = splitStatus(
  () => personalFilters.value,
  next => personalFilters.value = next
)

// Saved filters edit a local draft so chip interactions feel instant; each
// change persists (the page PATCHes the definition).
const sharedDraft = ref<Record<string, unknown>>({ ...(props.view.definition.filters ?? {}) })
watch(() => props.view.definition.filters, (v) => {
  sharedDraft.value = { ...(v ?? {}) }
})
const shared = splitStatus(
  () => sharedDraft.value,
  (next) => {
    sharedDraft.value = next
    emit('definitionFilters', next)
  }
)

const sharedCount = computed(() => Object.keys(props.view.definition.filters ?? {}).length)
const personalCount = computed(() => Object.keys(personalFilters.value).length)

// --- saved sort -------------------------------------------------------------
// Edited through a local draft so the select reflects the click before the
// PATCH round-trip lands; the definition stays the source of truth.

const sortDraft = ref(props.view.definition.sort ?? null)
watch(() => props.view.definition.sort, (v) => {
  sortDraft.value = v ?? null
})

const sortChoices = computed(() => viewsSortChoices(props.fields))
const sortItems = computed(() =>
  sortChoices.value.map(c => ({ label: c.label, value: c.key })))

const effectiveSort = computed(() => sortDraft.value ?? VIEWS_DEFAULT_SORT)
const sortLabel = computed(() =>
  sortChoices.value.find(c => c.key === effectiveSort.value.field)?.label
  ?? effectiveSort.value.field)

const sortField = computed<string>({
  get: () => effectiveSort.value.field,
  set: (field) => {
    const next = { field, dir: effectiveSort.value.dir }
    sortDraft.value = next
    emit('definitionSort', next)
  }
})

function toggleSortDir() {
  const next = {
    field: effectiveSort.value.field,
    dir: effectiveSort.value.dir === 'asc' ? 'desc' as const : 'asc' as const
  }
  sortDraft.value = next
  emit('definitionSort', next)
}

function clearSort() {
  sortDraft.value = null
  emit('definitionSort', null)
}

const savedOpen = ref(false)
</script>

<template>
  <div class="border-b border-(--ui-border) bg-(--ui-bg) px-4 py-2 space-y-2">
    <div class="flex items-center gap-2 flex-wrap">
      <div class="flex-1 min-w-64">
        <RecordFilters
          v-model:q="q"
          v-model:status="personal.status.value"
          v-model:filters="personal.rest.value"
          :status-field="statusField"
          :fields="fields"
        />
      </div>
      <UBadge
        v-if="personalCount > 0"
        variant="subtle"
        color="info"
        icon="i-lucide-user"
      >
        Personal
      </UBadge>
      <UBadge
        variant="subtle"
        color="neutral"
        :icon="effectiveSort.dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
      >
        {{ sortLabel }}
      </UBadge>
      <UButton
        v-if="canEditDefinition"
        :icon="savedOpen ? 'i-lucide-chevron-up' : 'i-lucide-bookmark'"
        variant="ghost"
        color="neutral"
        size="sm"
        @click="savedOpen = !savedOpen"
      >
        Saved filters{{ sharedCount > 0 ? ` (${sharedCount})` : '' }}
      </UButton>
      <UBadge
        v-else-if="sharedCount > 0"
        variant="subtle"
        color="neutral"
        icon="i-lucide-bookmark"
      >
        {{ sharedCount }} saved filter{{ sharedCount === 1 ? '' : 's' }}
      </UBadge>
    </div>

    <div
      v-if="savedOpen && canEditDefinition"
      class="rounded-lg border border-dashed border-(--ui-border) p-2"
    >
      <p class="text-xs text-(--ui-text-muted) mb-2">
        Saved filters and sort apply for everyone who opens this view.
      </p>

      <div class="flex items-center gap-2 flex-wrap mb-3">
        <span class="text-xs text-(--ui-text-muted)">Sort by</span>
        <USelectMenu
          v-model="sortField"
          :items="sortItems"
          value-key="value"
          label-key="label"
          size="xs"
          class="w-44"
        />
        <UButton
          :icon="effectiveSort.dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
          variant="outline"
          color="neutral"
          size="xs"
          :aria-label="effectiveSort.dir === 'asc' ? 'Sort ascending' : 'Sort descending'"
          @click="toggleSortDir"
        >
          {{ effectiveSort.dir === 'asc' ? 'Ascending' : 'Descending' }}
        </UButton>
        <UButton
          v-if="sortDraft"
          variant="ghost"
          color="neutral"
          size="xs"
          @click="clearSort"
        >
          Reset
        </UButton>
      </div>
      <!-- Text search is session state, not part of the saved definition —
           the wrapper hides RecordFilters' search input (its first row's
           first element) since the component has no prop for that. -->
      <div class="[&>div>div:first-child>*:first-child]:hidden">
        <RecordFilters
          v-model:status="shared.status.value"
          v-model:filters="shared.rest.value"
          :status-field="statusField"
          :fields="fields"
        />
      </div>
    </div>
  </div>
</template>
