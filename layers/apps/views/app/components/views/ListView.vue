<script setup lang="ts">
// The list renderer: rows in their manual order, optionally grouped into
// collapsible sections by a field. Dragging a row reorders it, or moves it
// into another section with the board's rules (single values move, tags and
// multi-values add). The checkbox closes or reopens a record on types with a
// single closed status; each section ends with a quick-add row.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsTabView, ViewRecords } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  records: ViewRecords
  fields: RecordsFieldSetting[]
  canCreate: boolean
  /** Rows of a hand-picked view can come off it (or, for its own cards, be deleted). */
  canRemove: boolean
  /** The type's closed status and the status a reopened record takes; null = no checkbox. */
  doneStatus: { done: string, reopen: string } | null
}>()

const emit = defineEmits<{
  move: [payload: { recordId: string, fromColumn: string | null, toColumn: string, columnOrder: string[] }]
  open: [recordId: string]
  quickAdd: [payload: { columnKey: string, name: string }]
  toggleDone: [payload: { recordId: string, done: boolean }]
  removeCard: [recordId: string]
  dragstart: []
  dragend: []
}>()

const grouped = computed(() => !!props.view.definition.groupField)
const groupField = computed(() =>
  props.fields.find(f => f.key === props.view.definition.groupField) ?? null)

const sections = useViewsColumns(() => ({
  definition: props.view.definition,
  records: props.records,
  fields: props.fields
}))

// Empty sections of a grouped list stay hidden unless they're option values
// (a status with nothing in it is still a place to drop).
const visibleSections = computed(() => sections.value.filter(s =>
  !grouped.value || s.cards.length > 0 || (groupField.value?.kind === 'key_select' || groupField.value?.kind === 'multi_select')))

const collapsed = ref(new Set<string>())
function toggleSection(key: string) {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

function isDone(status: string | null): boolean | null {
  if (!props.doneStatus) return null
  return status === props.doneStatus.done
}

// --- drag and drop -----------------------------------------------------------

const dragging = ref<{ recordId: string, fromColumn: string } | null>(null)
const dropTarget = ref<{ section: string, before: string | null } | null>(null)

function onDragStart(event: DragEvent, recordId: string, fromColumn: string) {
  dragging.value = { recordId, fromColumn }
  event.dataTransfer?.setData('text/plain', recordId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('dragstart')
}

function onDragEnd() {
  dragging.value = null
  dropTarget.value = null
  emit('dragend')
}

function onDragOver(event: DragEvent, section: string, before: string | null) {
  if (!dragging.value) return
  event.preventDefault()
  dropTarget.value = { section, before }
}

function onDrop(section: string) {
  const drag = dragging.value
  const target = dropTarget.value
  dragging.value = null
  dropTarget.value = null
  if (!drag || !target || target.section !== section) return
  if (drag.recordId === target.before) return
  const column = sections.value.find(s => s.key === section)
  if (!column) return
  const ids = column.cards.map(c => c.id).filter(id => id !== drag.recordId)
  const at = target.before ? ids.indexOf(target.before) : -1
  if (at >= 0) ids.splice(at, 0, drag.recordId)
  else ids.push(drag.recordId)
  emit('move', { recordId: drag.recordId, fromColumn: drag.fromColumn, toColumn: section, columnOrder: ids })
}

// --- quick add -----------------------------------------------------------------

const drafts = ref<Record<string, string>>({})
function submitQuickAdd(section: string) {
  const name = (drafts.value[section] ?? '').trim()
  if (!name) return
  emit('quickAdd', { columnKey: section, name })
  drafts.value = { ...drafts.value, [section]: '' }
}
</script>

<template>
  <div class="h-full overflow-y-auto rounded-lg border border-(--ui-border)">
    <section
      v-for="section in visibleSections"
      :key="section.key"
      @dragover="onDragOver($event, section.key, null)"
      @drop.prevent="onDrop(section.key)"
    >
      <button
        v-if="grouped"
        type="button"
        class="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium bg-(--ui-bg-elevated) border-b border-(--ui-border)"
        @click="toggleSection(section.key)"
      >
        <UIcon
          :name="collapsed.has(section.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          class="size-3.5"
        />
        <span>{{ section.label }}</span>
        <span class="text-(--ui-text-dimmed) tabular-nums">{{ section.cards.length }}</span>
      </button>

      <template v-if="!collapsed.has(section.key)">
        <ViewsListRow
          v-for="item in section.cards"
          :key="`${section.key}:${item.id}`"
          :item="item"
          :fields="fields"
          :card-fields="records.card.fields"
          :card-connections="records.card.connections"
          :group-field-key="view.definition.groupField ?? null"
          :done="isDone(item.status)"
          :drop-before="dropTarget?.section === section.key && dropTarget.before === item.id && dragging?.recordId !== item.id"
          :removable="view.picked && canRemove"
          @open="emit('open', $event)"
          @toggle="emit('toggleDone', { recordId: item.id, done: $event })"
          @remove="emit('removeCard', item.id)"
          @dragstart="onDragStart($event, item.id, section.key)"
          @dragend="onDragEnd"
          @dragover.stop="onDragOver($event, section.key, item.id)"
        />

        <form
          v-if="canCreate"
          class="flex items-center gap-2 px-3 py-1.5 border-b border-(--ui-border)"
          @submit.prevent="submitQuickAdd(section.key)"
        >
          <UIcon
            name="i-lucide-plus"
            class="size-4 text-(--ui-text-dimmed)"
          />
          <input
            v-model="drafts[section.key]"
            type="text"
            placeholder="Add…"
            class="flex-1 bg-transparent text-sm outline-none placeholder:text-(--ui-text-dimmed)"
          >
        </form>
      </template>
    </section>

    <p
      v-if="records.items.length === 0 && !canCreate"
      class="p-6 text-center text-sm text-(--ui-text-muted)"
    >
      Nothing here yet.
    </p>
  </div>
</template>
