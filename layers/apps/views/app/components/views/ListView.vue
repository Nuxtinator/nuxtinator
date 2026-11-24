<script setup lang="ts">
// The list renderer: rows in their manual order, optionally grouped into
// collapsible sections by a field. Dragging a row reorders it, or moves it
// into another section with the board's rules (single values move, tags and
// multi-values add). The checkbox closes or reopens a record on types with a
// single closed status; each section ends with a quick-add row. Rows load a
// page at a time: scrolling near the end asks for the next. A section drags
// by the grip in its header to change the view's column order for the
// grouping field, the order its boards show too.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsTabView, ViewRecords } from '../../utils/views-types'
import { VIEWS_NO_VALUE_COLUMN } from '../../utils/views-types'
import { viewsMoveColumnKey, type ViewsColumnPositions } from '../../utils/views-column-order'

const props = defineProps<{
  view: ViewsTabView
  records: ViewRecords
  fields: RecordsFieldSetting[]
  /** The view's column order for the grouping field. */
  columnOrder?: ViewsColumnPositions
  /** The caller can change that order. */
  canOrderSections?: boolean
  canCreate: boolean
  /** Rows of a hand-picked view can come off it (or, for its own cards, be deleted). */
  canRemove: boolean
  /** The type's closed status and the status a reopened record takes; null = no checkbox. */
  doneStatus: { done: string, reopen: string } | null
  /** More rows than are loaded match the tab. */
  hasMore?: boolean
}>()

const emit = defineEmits<{
  move: [payload: { recordId: string, fromColumn: string | null, toColumn: string, columnOrder: string[] }]
  /** Section `key` was dragged to where it sits in `order` ("No value" left out). */
  placeColumn: [payload: { key: string, order: string[] }]
  open: [recordId: string]
  quickAdd: [payload: { columnKey: string, name: string }]
  toggleDone: [payload: { recordId: string, done: boolean }]
  removeCard: [recordId: string]
  loadMore: []
  dragstart: []
  dragend: []
}>()

const scroller = ref<HTMLElement | null>(null)
function nearEnd() {
  const el = scroller.value
  if (!el || !props.hasMore) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) emit('loadMore')
}
// A page that doesn't fill the list asks for the next one straight away.
watch(() => [props.records.items.length, props.hasMore], () => nextTick(nearEnd))
onMounted(nearEnd)

const grouped = computed(() => !!props.view.definition.groupField)
const groupField = computed(() =>
  props.fields.find(f => f.key === props.view.definition.groupField) ?? null)

const sections = useViewsColumns(() => ({
  definition: props.view.definition,
  records: props.records,
  fields: props.fields,
  columnOrder: props.columnOrder
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

// A drag ends once: on its drop, or on dragend when it was cancelled. A row
// dropped in another section is unmounted before its dragend could arrive.
function onDragEnd() {
  dropTarget.value = null
  if (!dragging.value) return
  dragging.value = null
  emit('dragend')
}

function onDragOver(event: DragEvent, section: string, before: string | null) {
  if (draggingSection.value !== null) return onSectionDragOver(event, section)
  if (!dragging.value) return
  event.preventDefault()
  dropTarget.value = { section, before }
}

function onDrop(section: string) {
  if (draggingSection.value !== null) return onSectionDrop()
  const drag = dragging.value
  const target = dropTarget.value
  onDragEnd()
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

// --- section order -------------------------------------------------------------

const draggingSection = ref<string | null>(null)
// The section a dragged one would land next to, and on which side.
const sectionDrop = ref<{ key: string, after: boolean } | null>(null)

function onSectionDragStart(event: DragEvent, key: string) {
  draggingSection.value = key
  event.dataTransfer?.setData('text/plain', key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('dragstart')
}

function onSectionDragEnd() {
  sectionDrop.value = null
  if (draggingSection.value === null) return
  draggingSection.value = null
  emit('dragend')
}

// Above or below the section the pointer is over, by its half; nothing goes
// above the "No value" section.
function onSectionDragOver(event: DragEvent, key: string) {
  event.preventDefault()
  if (key === draggingSection.value) {
    sectionDrop.value = null
    return
  }
  const target = event.currentTarget as HTMLElement
  const rect = (target.closest('section') ?? target).getBoundingClientRect()
  const after = key === VIEWS_NO_VALUE_COLUMN || event.clientY > rect.top + rect.height / 2
  sectionDrop.value = { key, after }
}

function onSectionDrop() {
  const from = draggingSection.value
  const target = sectionDrop.value
  onSectionDragEnd()
  if (!from || !target) return
  const keys = sections.value.map(s => s.key).filter(k => k !== VIEWS_NO_VALUE_COLUMN)
  const order = viewsMoveColumnKey(keys, from, target.key, target.after)
  if (order) emit('placeColumn', { key: from, order })
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
  <div
    ref="scroller"
    class="h-full overflow-y-auto rounded-lg border border-(--ui-border)"
    @scroll.passive="nearEnd"
  >
    <section
      v-for="section in visibleSections"
      :key="section.key"
      class="relative"
      @dragover="onDragOver($event, section.key, null)"
      @drop.prevent="onDrop(section.key)"
    >
      <div
        v-if="sectionDrop?.key === section.key"
        class="absolute inset-x-0 z-20 h-0.5 bg-(--ui-primary)"
        :class="sectionDrop.after ? 'bottom-0' : 'top-0'"
      />
      <div
        v-if="grouped"
        class="sticky top-0 z-10 flex w-full items-center gap-1 px-3 py-1.5 text-xs font-medium bg-(--ui-bg-elevated) border-b border-(--ui-border)"
      >
        <!-- The pinned "No value" section keeps the grip's space so the labels line up. -->
        <span
          v-if="canOrderSections"
          :draggable="section.key !== VIEWS_NO_VALUE_COLUMN"
          class="-ml-1 shrink-0 cursor-grab active:cursor-grabbing text-(--ui-text-dimmed)"
          :class="{ invisible: section.key === VIEWS_NO_VALUE_COLUMN }"
          @dragstart="onSectionDragStart($event, section.key)"
          @dragend="onSectionDragEnd"
        >
          <UIcon
            name="i-lucide-grip-vertical"
            class="size-3.5 block"
          />
        </span>
        <button
          type="button"
          class="flex flex-1 items-center gap-2 text-left"
          @click="toggleSection(section.key)"
        >
          <UIcon
            :name="collapsed.has(section.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
            class="size-3.5"
          />
          <span>{{ section.label }}</span>
          <span
            v-if="!hasMore"
            class="text-(--ui-text-dimmed) tabular-nums"
          >{{ section.cards.length }}</span>
        </button>
      </div>

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

    <div
      v-if="hasMore"
      class="flex items-center justify-center gap-2 p-4 text-sm text-(--ui-text-muted)"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      Loading more…
    </div>
  </div>
</template>
