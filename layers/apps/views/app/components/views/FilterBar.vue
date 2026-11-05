<script setup lang="ts">
// The tab toolbar: a quick text search that is never saved, the tab's filter
// behind a "Filter · N" button that opens the filter builder, and — on boards
// and lists — the tab's saved sort. Filter and sort edits save to the tab for
// everyone; people who can only view open the builder read-only.
import { recordsFilterRuleCount } from '#records'
import type { RecordsFieldSetting, RecordsFilterGroup } from '#records/client'
import type { ViewsTabView, ViewsViewDefinition } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  viewDefinition: ViewsViewDefinition
  fields: RecordsFieldSetting[]
  canEditDefinition: boolean
  saving?: boolean
}>()

const q = defineModel<string>('q', { default: '' })

const emit = defineEmits<{
  definitionFilter: [filter: RecordsFilterGroup | null]
  definitionSort: [sort: { field: string, dir: 'asc' | 'desc' } | null]
}>()

const filterOpen = ref(false)
const filterCount = computed(() => recordsFilterRuleCount(props.view.definition.filter))
const baseCount = computed(() => recordsFilterRuleCount(props.viewDefinition.filter))

function onFilterSave(filter: RecordsFilterGroup | null) {
  emit('definitionFilter', filter)
  filterOpen.value = false
}

// --- saved sort -------------------------------------------------------------
// Edited through a local draft so the select reflects the click before the
// PATCH round-trip lands; the definition stays the source of truth. Tables
// sort from their column headers instead.

const showSort = computed(() => props.view.viewType !== 'table')
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
</script>

<template>
  <div class="border-b border-(--ui-border) bg-(--ui-bg) px-4 py-2">
    <div class="flex items-center gap-2 flex-wrap">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search…"
        size="sm"
        class="w-56"
      />
      <UButton
        icon="i-lucide-list-filter"
        :variant="filterCount > 0 ? 'soft' : 'ghost'"
        :color="filterCount > 0 ? 'primary' : 'neutral'"
        size="sm"
        @click="filterOpen = true"
      >
        Filter{{ filterCount > 0 ? ` · ${filterCount}` : '' }}
      </UButton>
      <UBadge
        v-if="baseCount > 0"
        variant="subtle"
        color="neutral"
        icon="i-lucide-lock"
      >
        View filter · {{ baseCount }}
      </UBadge>

      <span class="flex-1" />

      <template v-if="showSort">
        <template v-if="canEditDefinition">
          <span class="text-xs text-(--ui-text-muted)">Sort</span>
          <USelectMenu
            v-model="sortField"
            :items="sortItems"
            value-key="value"
            label-key="label"
            size="xs"
            class="w-36"
          />
          <UButton
            :icon="effectiveSort.dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
            variant="ghost"
            color="neutral"
            size="xs"
            :aria-label="effectiveSort.dir === 'asc' ? 'Sort ascending' : 'Sort descending'"
            @click="toggleSortDir"
          />
        </template>
        <UBadge
          v-else
          variant="subtle"
          color="neutral"
          :icon="effectiveSort.dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
        >
          {{ sortLabel }}
        </UBadge>
      </template>
    </div>

    <ViewsFilterModal
      v-model:open="filterOpen"
      :title="canEditDefinition ? 'Filter this tab' : 'This tab\'s filter'"
      :fields="fields"
      :filter="view.definition.filter ?? null"
      :base="viewDefinition.filter ?? null"
      :readonly="!canEditDefinition"
      :saving="saving"
      @save="onFilterSave"
    />
  </div>
</template>
