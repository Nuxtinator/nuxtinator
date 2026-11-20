<script setup lang="ts">
// The tab toolbar: a quick text search that is never saved, the tab's filter
// behind a "Filter · N" button that opens the filter builder, and — on boards
// and lists — the tab's saved sort. Filter and sort edits save to the tab for
// everyone; people who can only view open the builder read-only and see the
// sort. The board of a record's children keeps its sort for that record,
// changed by people who can edit the record.
import { recordsFilterRuleCount } from '#records'
import type { RecordsFieldSetting, RecordsFilterGroup } from '#records/client'
import type { ViewsTabView, ViewsViewDefinition } from '../../utils/views-types'

type Sort = { field: string, dir: 'asc' | 'desc' }

const props = defineProps<{
  view: ViewsTabView
  viewDefinition: ViewsViewDefinition
  fields: RecordsFieldSetting[]
  canEditDefinition: boolean
  /** The sort the board's record keeps in place of the tab's (a card's board). */
  recordSort?: Sort | null
  /** The viewer can change that sort. */
  canSortRecord?: boolean
  /** On a board in the order set under a record: whether anyone has placed a card in it yet. */
  manualOrdered?: boolean
  saving?: boolean
}>()

const q = defineModel<string>('q', { default: '' })

const emit = defineEmits<{
  definitionFilter: [filter: RecordsFilterGroup | null]
  definitionSort: [sort: Sort | null]
  recordSort: [sort: Sort | null]
}>()

const filterOpen = ref(false)
const filterCount = computed(() => recordsFilterRuleCount(props.view.definition.filter))
const baseCount = computed(() => recordsFilterRuleCount(props.viewDefinition.filter))

function onFilterSave(filter: RecordsFilterGroup | null) {
  emit('definitionFilter', filter)
  filterOpen.value = false
}

defineExpose({ openFilter: () => { filterOpen.value = true } })

// --- saved sort -------------------------------------------------------------
// Edited through a local draft so the select reflects the click before the
// save lands; the saved sort stays the source of truth. Tables sort from
// their column headers instead, and calendars order by date.

const showSort = computed(() => props.view.viewType !== 'table' && props.view.viewType !== 'calendar')
const canSort = computed(() => props.canEditDefinition || !!props.canSortRecord)
const savedSort = computed(() => props.recordSort ?? props.view.definition.sort ?? null)
const sortDraft = ref(savedSort.value)
watch(savedSort, (v) => {
  sortDraft.value = v
})

// A tab that shows the order set under a record offers it as "Manual". Until
// anyone places a card that order is the cards oldest first, so it reads as
// "Created", and the first drag makes it "Manual".
const offersManual = computed(() => props.view.definition.sort?.field === VIEWS_MANUAL_SORT)
const manualStarted = computed(() => props.manualOrdered === true)
const hasManual = computed(() => offersManual.value && manualStarted.value)
const sortChoices = computed(() => viewsSortChoices(props.fields))
const sortItems = computed(() => [
  ...(hasManual.value ? [{ label: 'Manual', value: VIEWS_MANUAL_SORT }] : []),
  ...sortChoices.value.map(c => ({ label: c.label, value: c.key }))
])

function shown(sort: Sort): Sort {
  return sort.field === VIEWS_MANUAL_SORT && !manualStarted.value ? VIEWS_DEFAULT_SORT : sort
}
const effectiveSort = computed(() => shown(sortDraft.value ?? VIEWS_DEFAULT_SORT))
const isManual = computed(() => effectiveSort.value.field === VIEWS_MANUAL_SORT)

// Picking what the board shows on its own stores nothing for the record.
function saveSort(next: Sort) {
  if (props.canEditDefinition) {
    emit('definitionSort', next)
    return
  }
  const own = props.view.definition.sort ?? VIEWS_DEFAULT_SORT
  const same = (a: Sort, b: Sort) => a.field === b.field && a.dir === b.dir
  emit('recordSort', same(next, own) || same(next, shown(own)) ? null : next)
}
const sortLabel = computed(() =>
  sortItems.value.find(i => i.value === effectiveSort.value.field)?.label
  ?? effectiveSort.value.field)

const sortField = computed<string>({
  get: () => effectiveSort.value.field,
  // A newly picked field starts ascending (oldest, A to Z, soonest first).
  set: (field) => {
    const next = { field, dir: 'asc' as const }
    sortDraft.value = next
    saveSort(next)
  }
})

function toggleSortDir() {
  const next = {
    field: effectiveSort.value.field,
    dir: effectiveSort.value.dir === 'asc' ? 'desc' as const : 'asc' as const
  }
  sortDraft.value = next
  saveSort(next)
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
        :ui="{ trailing: 'pe-1' }"
        @keydown.esc="q = ''"
      >
        <template v-if="q" #trailing>
          <UButton
            icon="i-lucide-x"
            variant="link"
            color="neutral"
            size="xs"
            aria-label="Clear search"
            @click="q = ''"
          />
        </template>
      </UInput>
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
        <template v-if="canSort">
          <span class="text-xs text-(--ui-text-muted)">
            Sort
            <InfoTip
              v-if="offersManual"
              text="Everyone sees this board in this order. Manual is the order set by dragging cards; cards nobody has moved stay oldest first."
            />
          </span>
          <USelectMenu
            v-model="sortField"
            :items="sortItems"
            value-key="value"
            label-key="label"
            size="xs"
            class="w-36"
          />
          <UButton
            v-if="!isManual"
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
          :icon="isManual ? 'i-lucide-grip-vertical' : effectiveSort.dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
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
