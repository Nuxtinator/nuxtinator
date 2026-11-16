<script setup lang="ts">
// The calendar renderer: a month of whole weeks with each record on the day
// of the tab's date field, or across every day from it to the end field.
// Dragging a record to another day changes its dates (an end date moves by
// the same number of days); the Unscheduled tray lists records with no date,
// ready to drag onto a day. Each day's "+" adds a record on that day.
// Records placed by Created or Updated stay where they are.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewRecords, ViewsBoardItem, ViewsTabView } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  records: ViewRecords
  fields: RecordsFieldSetting[]
  /** The days the grid shows, whole weeks (viewsMonthGrid). */
  days: string[]
  canCreate: boolean
  /** The type's closed status; done records show struck through. */
  doneStatus: { done: string, reopen: string } | null
}>()

const month = defineModel<string>('month', { required: true })

const emit = defineEmits<{
  open: [recordId: string]
  quickAdd: [payload: { name: string, values: Record<string, unknown> }]
  reschedule: [payload: { recordId: string, values: Record<string, unknown> }]
  dragstart: []
  dragend: []
}>()

const MAX_PER_DAY = 3
const today = viewsDayKey(new Date())

const dateKey = computed(() => props.view.definition.dateField ?? '')
const endKey = computed(() => props.view.definition.endField ?? null)
const kindOf = (key: string) =>
  key === 'created_at' || key === 'updated_at' ? 'datetime' : props.fields.find(f => f.key === key)?.kind ?? 'date'
const movable = computed(() => dateKey.value !== 'created_at' && dateKey.value !== 'updated_at')
const statusField = computed(() => props.fields.find(f => f.column === 'status') ?? null)

const monthLabel = computed(() =>
  viewsDayDate(`${month.value}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
const weekdays = computed(() =>
  props.days.slice(0, 7).map(d => viewsDayDate(d).toLocaleDateString(undefined, { weekday: 'short' })))
const weeks = computed(() => props.days.length / 7)

interface Placed {
  item: ViewsBoardItem
  /** Continues from the day before / onto the day after. */
  fromBefore: boolean
  toAfter: boolean
}

// Each record on every grid day from its start to its end (a single day
// without an end field, or when the end comes before the start).
const byDay = computed(() => {
  const out = new Map<string, Placed[]>()
  const first = props.days[0]
  const last = props.days[props.days.length - 1]
  if (!first || !last) return out
  for (const item of props.records.items) {
    const start = viewsValueDay(viewsItemValue(item, dateKey.value))
    if (!start) continue
    const rawEnd = endKey.value ? viewsValueDay(viewsItemValue(item, endKey.value)) : null
    const end = rawEnd && rawEnd > start ? rawEnd : start
    let day = start < first ? first : start
    const stop = end > last ? last : end
    while (day <= stop) {
      const list = out.get(day) ?? []
      list.push({ item, fromBefore: day > start, toAfter: day < end })
      out.set(day, list)
      day = viewsShiftDay(day, 1)
    }
  }
  return out
})

function isDone(item: ViewsBoardItem): boolean {
  return !!props.doneStatus && item.status === props.doneStatus.done
}

function statusDot(item: ViewsBoardItem): string {
  const field = statusField.value
  const color = field ? recordsOptionColor(field, item.status ?? (typeof field.default === 'string' ? field.default : null)) : 'neutral'
  return color === 'neutral' ? 'var(--ui-border-accented)' : `var(--ui-${color})`
}

// --- drag and drop -----------------------------------------------------------

const dragging = ref<{ item: ViewsBoardItem, fromDay: string | null } | null>(null)
const dropDay = ref<string | null>(null)

function onDragStart(event: DragEvent, item: ViewsBoardItem, fromDay: string | null) {
  if (!movable.value) return
  dragging.value = { item, fromDay }
  event.dataTransfer?.setData('text/plain', item.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('dragstart')
}

function onDragEnd() {
  dragging.value = null
  dropDay.value = null
  emit('dragend')
}

function onDragOver(event: DragEvent, day: string) {
  if (!dragging.value) return
  event.preventDefault()
  dropDay.value = day
}

// The record's start moves by as many days as it was dragged (grabbing the
// third day of a span keeps it the third day); its end moves with it.
function onDrop(day: string) {
  const drag = dragging.value
  dragging.value = null
  dropDay.value = null
  if (!drag) return
  const startRaw = viewsItemValue(drag.item, dateKey.value)
  const start = viewsValueDay(startRaw)
  const shift = start && drag.fromDay ? viewsDaysBetween(drag.fromDay, day) : 0
  if (start && shift === 0) return
  const newStart = start ? viewsShiftDay(start, shift) : day
  const values: Record<string, unknown> = {
    [dateKey.value]: viewsValueOnDay(kindOf(dateKey.value), newStart, startRaw)
  }
  const endRaw = endKey.value ? viewsItemValue(drag.item, endKey.value) : null
  const end = viewsValueDay(endRaw)
  if (endKey.value && end && start) {
    values[endKey.value] = viewsValueOnDay(kindOf(endKey.value), viewsShiftDay(end, shift), endRaw)
  }
  emit('reschedule', { recordId: drag.item.id, values })
}

// --- quick add -----------------------------------------------------------------

const addingDay = ref<string | null>(null)
const draft = ref('')
const vFocus = { mounted: (el: HTMLElement) => el.focus() }

function startAdd(day: string) {
  addingDay.value = day
  draft.value = ''
}

function submitAdd() {
  const day = addingDay.value
  const name = draft.value.trim()
  addingDay.value = null
  if (!day || !name) return
  const values: Record<string, unknown> = {}
  if (movable.value) values[dateKey.value] = viewsValueOnDay(kindOf(dateKey.value), day, null)
  emit('quickAdd', { name, values })
}

// --- unscheduled tray ----------------------------------------------------------

const trayOpen = ref(false)
const unscheduledCount = computed(() => props.records.unscheduled?.total ?? 0)
</script>

<template>
  <div class="h-full flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <UButton
        icon="i-lucide-chevron-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Previous month"
        @click="month = viewsShiftMonth(month, -1)"
      />
      <UButton
        variant="outline"
        color="neutral"
        size="sm"
        @click="month = today.slice(0, 7)"
      >
        Today
      </UButton>
      <UButton
        icon="i-lucide-chevron-right"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Next month"
        @click="month = viewsShiftMonth(month, 1)"
      />
      <h2 class="text-base font-semibold ml-1">
        {{ monthLabel }}
      </h2>
      <span class="flex-1" />
      <UButton
        v-if="records.unscheduled"
        icon="i-lucide-calendar-off"
        :variant="trayOpen ? 'soft' : 'ghost'"
        color="neutral"
        size="sm"
        @click="trayOpen = !trayOpen"
      >
        Unscheduled
        <span class="tabular-nums text-(--ui-text-dimmed)">{{ unscheduledCount }}</span>
      </UButton>
    </div>

    <div class="flex-1 min-h-0 flex gap-3">
      <div
        class="flex-1 min-w-0 grid grid-cols-7 rounded-lg border border-(--ui-border) overflow-hidden"
        :style="{ gridTemplateRows: `auto repeat(${weeks}, minmax(6rem, 1fr))` }"
      >
        <div
          v-for="name in weekdays"
          :key="name"
          class="px-2 py-1 text-xs font-medium text-(--ui-text-muted) border-b border-(--ui-border) bg-(--ui-bg-elevated)/50"
        >
          {{ name }}
        </div>

        <div
          v-for="(day, index) in days"
          :key="day"
          class="group relative flex flex-col min-h-0 p-1 border-(--ui-border) transition-colors"
          :class="[
            index % 7 !== 6 ? 'border-r' : '',
            index < days.length - 7 ? 'border-b' : '',
            day.slice(0, 7) !== month ? 'bg-(--ui-bg-elevated)/30' : '',
            dropDay === day ? 'bg-(--ui-primary)/10' : ''
          ]"
          @dragover="onDragOver($event, day)"
          @dragleave="dropDay === day && (dropDay = null)"
          @drop.prevent="onDrop(day)"
        >
          <div class="flex items-center justify-between mb-0.5">
            <span
              class="inline-grid place-items-center size-6 rounded-full text-xs tabular-nums"
              :class="day === today
                ? 'bg-(--ui-primary) text-(--ui-bg) font-semibold'
                : day.slice(0, 7) === month ? 'text-(--ui-text)' : 'text-(--ui-text-dimmed)'"
            >
              {{ Number(day.slice(8)) }}
            </span>
            <UButton
              v-if="canCreate"
              icon="i-lucide-plus"
              variant="ghost"
              color="neutral"
              size="xs"
              class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              :aria-label="`Add on ${viewsDayDate(day).toLocaleDateString()}`"
              @click="startAdd(day)"
            />
          </div>

          <div class="flex flex-col gap-0.5 min-h-0">
            <button
              v-for="placed in (byDay.get(day) ?? []).slice(0, MAX_PER_DAY)"
              :key="placed.item.id"
              type="button"
              :draggable="movable"
              class="flex items-center gap-1 px-1.5 py-0.5 text-xs text-left truncate bg-(--ui-primary)/10 hover:bg-(--ui-primary)/20"
              :class="[
                placed.fromBefore ? '-ml-1 rounded-l-none' : 'rounded-l',
                placed.toAfter ? '-mr-1 rounded-r-none' : 'rounded-r',
                movable ? 'cursor-grab active:cursor-grabbing' : '',
                isDone(placed.item) ? 'line-through text-(--ui-text-muted)' : ''
              ]"
              :title="placed.item.name"
              @click="emit('open', placed.item.id)"
              @dragstart="onDragStart($event, placed.item, day)"
              @dragend="onDragEnd"
            >
              <span
                v-if="!placed.fromBefore"
                class="size-1.5 shrink-0 rounded-full"
                :style="{ background: statusDot(placed.item) }"
              />
              <span class="truncate">{{ placed.item.name }}</span>
            </button>

            <UPopover v-if="(byDay.get(day)?.length ?? 0) > MAX_PER_DAY">
              <UButton
                variant="link"
                color="neutral"
                size="xs"
                class="px-1.5 py-0"
              >
                {{ byDay.get(day)!.length - MAX_PER_DAY }} more
              </UButton>
              <template #content>
                <div class="p-2 w-64 space-y-1">
                  <p class="px-1 text-xs font-medium text-(--ui-text-muted)">
                    {{ viewsDayDate(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) }}
                  </p>
                  <button
                    v-for="placed in byDay.get(day)"
                    :key="placed.item.id"
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm text-left hover:bg-(--ui-bg-elevated)"
                    :class="isDone(placed.item) ? 'line-through text-(--ui-text-muted)' : ''"
                    @click="emit('open', placed.item.id)"
                  >
                    <span
                      class="size-1.5 shrink-0 rounded-full"
                      :style="{ background: statusDot(placed.item) }"
                    />
                    <span class="truncate">{{ placed.item.name }}</span>
                  </button>
                </div>
              </template>
            </UPopover>

            <form
              v-if="addingDay === day"
              @submit.prevent="submitAdd"
            >
              <input
                v-model="draft"
                type="text"
                v-focus
                placeholder="Add…"
                class="w-full rounded border border-(--ui-border-accented) bg-(--ui-bg) px-1.5 py-0.5 text-xs outline-none focus:border-(--ui-primary)"
                @keydown.esc="addingDay = null"
                @blur="submitAdd"
              >
            </form>
          </div>
        </div>
      </div>

      <aside
        v-if="trayOpen && records.unscheduled"
        class="w-64 shrink-0 flex flex-col rounded-lg border border-(--ui-border) overflow-hidden"
        aria-label="Unscheduled"
      >
        <div class="flex items-center gap-2 px-3 py-2 border-b border-(--ui-border) text-sm font-medium">
          Unscheduled
          <InfoTip
            v-if="movable"
            text="Records with no date. Drag one onto a day to schedule it."
          />
          <span class="flex-1" />
          <span class="text-xs text-(--ui-text-dimmed) tabular-nums">{{ unscheduledCount }}</span>
        </div>
        <div class="flex-1 overflow-y-auto p-1">
          <button
            v-for="item in records.unscheduled.items"
            :key="item.id"
            type="button"
            :draggable="movable"
            class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm text-left hover:bg-(--ui-bg-elevated)"
            :class="[
              movable ? 'cursor-grab active:cursor-grabbing' : '',
              isDone(item) ? 'line-through text-(--ui-text-muted)' : ''
            ]"
            @click="emit('open', item.id)"
            @dragstart="onDragStart($event, item, null)"
            @dragend="onDragEnd"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :style="{ background: statusDot(item) }"
            />
            <span class="truncate">{{ item.name }}</span>
          </button>
          <p
            v-if="records.unscheduled.items.length === 0"
            class="p-4 text-center text-sm text-(--ui-text-muted)"
          >
            Everything has a date.
          </p>
          <p
            v-else-if="unscheduledCount > records.unscheduled.items.length"
            class="px-2 py-1.5 text-xs text-(--ui-text-dimmed)"
          >
            Showing {{ records.unscheduled.items.length }} of {{ unscheduledCount }}.
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
