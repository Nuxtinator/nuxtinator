<script setup lang="ts">
// The kanban renderer. Groups the feed into columns, orders cards (manual
// ranks first, feed order for the rest), and turns drops into move payloads
// carrying the target column's record ids in visual order — the server
// derives ranks from that. Two modes:
//
// - Field-grouped: columns are the grouping field's options (selects), the
//   users or tags present on cards (plus tag columns added this session), or
//   the target type's records (connections), with a leading "No value"
//   column. A card with several values appears in each matching column.
//   Adding a column mints a tag (local until a card lands in it) or creates a
//   record of the connection's target type.
// - Custom: columns come from the view definition; membership from
//   placements. A placement pointing at a removed column renders in the
//   first column so no card silently disappears.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardColumn } from './KanbanColumn.vue'
import type {
  ViewsBoardItem,
  ViewsColumnDef,
  ViewDetail,
  ViewRecords
} from '../../utils/views-types'
import { VIEWS_NO_VALUE_COLUMN } from '../../utils/views-types'

const props = defineProps<{
  view: ViewDetail
  records: ViewRecords
  fields: RecordsFieldSetting[]
  /** edit/owner on the view — column management on custom boards. */
  canEditDefinition: boolean
  /** The caller may create records of this type (server re-enforces). */
  canCreate: boolean
}>()

const emit = defineEmits<{
  move: [payload: { recordId: string, fromColumn: string | null, toColumn: string, columnOrder: string[] }]
  open: [recordId: string]
  quickAdd: [payload: { columnKey: string, name: string }]
  addExisting: [columnKey: string]
  columnsChange: [columns: ViewsColumnDef[]]
  /** Connection-grouped boards: create a target record named `label` as a new column. */
  addTargetColumn: [label: string]
  removeCard: [recordId: string]
  dragstart: []
  dragend: []
}>()

const { byId: usersById, ensureUsers } = useRecordsUsers()

const definition = computed(() => props.view.definition)
const isCustom = computed(() => !!definition.value.columns)
const groupField = computed<RecordsFieldSetting | null>(() =>
  definition.value.groupField
    ? props.fields.find(f => f.key === definition.value.groupField) ?? null
    : null)

onMounted(() => {
  if (groupField.value?.kind === 'user_select') {
    ensureUsers().catch(() => {
      // Column labels fall back to raw ids.
    })
  }
})

const cardFields = computed(() => props.records.card.fields)
const cardConnections = computed(() => props.records.card.connections)

// Tag columns added from the board this session; they become real columns
// the moment a card carries the tag, and vanish on reload otherwise.
const pendingTagColumns = ref<string[]>([])

const canAddGroupColumn = computed(() =>
  !isCustom.value && (groupField.value?.kind === 'tags' || groupField.value?.kind === 'connection'))

// rank lookup: `${recordId}:${columnKey}` → rank
const ranks = computed(() => {
  const map = new Map<string, string>()
  for (const p of props.records.placements) {
    if (p.rank) map.set(`${p.recordId}:${p.columnKey}`, p.rank)
  }
  return map
})

function orderCards(cards: ViewsBoardItem[], columnKey: string): ViewsBoardItem[] {
  const ranked: Array<{ card: ViewsBoardItem, rank: string }> = []
  const rest: ViewsBoardItem[] = []
  for (const card of cards) {
    const rank = ranks.value.get(`${card.id}:${columnKey}`)
    if (rank) ranked.push({ card, rank })
    else rest.push(card)
  }
  ranked.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)
  return [...ranked.map(r => r.card), ...rest]
}

const columns = computed<ViewsBoardColumn[]>(() => {
  const items = props.records.items

  if (isCustom.value) {
    const defs = definition.value.columns ?? []
    const byColumn = new Map<string, ViewsBoardItem[]>(defs.map(d => [d.key, []]))
    const columnOf = new Map<string, string>()
    for (const p of props.records.placements) columnOf.set(p.recordId, p.columnKey)
    const fallback = defs[0]?.key
    for (const item of items) {
      const key = columnOf.get(item.id)
      const target = key !== undefined && byColumn.has(key) ? key : fallback
      if (target !== undefined) byColumn.get(target)!.push(item)
    }
    return defs.map(d => ({
      key: d.key,
      label: d.label,
      color: d.color,
      cards: orderCards(byColumn.get(d.key) ?? [], d.key)
    }))
  }

  const field = groupField.value
  if (!field) return []

  const byColumn = new Map<string, ViewsBoardItem[]>()
  const add = (key: string, item: ViewsBoardItem) => {
    if (!byColumn.has(key)) byColumn.set(key, [])
    byColumn.get(key)!.push(item)
  }
  for (const item of items) {
    const values = item.groupValues ?? []
    if (values.length === 0) add(VIEWS_NO_VALUE_COLUMN, item)
    for (const value of values) add(value, item)
  }

  const defs: Array<{ key: string, label: string, color?: string }> = [
    { key: VIEWS_NO_VALUE_COLUMN, label: `No ${field.label.toLowerCase()}` }
  ]
  if (field.kind === 'connection') {
    for (const col of props.records.groupColumns ?? []) defs.push({ key: col.key, label: col.label })
    // A card may point at a target the caller can't list (or past the cap).
    for (const key of byColumn.keys()) {
      if (key !== VIEWS_NO_VALUE_COLUMN && !defs.some(d => d.key === key)) defs.push({ key, label: 'Linked record' })
    }
  } else if (field.kind === 'tags') {
    const seen = new Set<string>()
    for (const [key, option] of Object.entries(field.options ?? {})) {
      if (option.deleted) continue
      seen.add(key)
      defs.push({ key, label: option.label, color: option.color })
    }
    const present = [...byColumn.keys()].filter(k => k !== VIEWS_NO_VALUE_COLUMN && !seen.has(k)).sort((a, b) => a.localeCompare(b))
    for (const tag of [...present, ...pendingTagColumns.value.filter(t => !present.includes(t) && !seen.has(t))]) {
      defs.push({ key: tag, label: tag })
    }
  } else if (field.kind === 'user_select') {
    // User columns exist where cards are — there is no fixed option set.
    const present = [...byColumn.keys()].filter(k => k !== VIEWS_NO_VALUE_COLUMN).sort((a, b) => {
      const an = usersById.value.get(a)?.name ?? a
      const bn = usersById.value.get(b)?.name ?? b
      return an.localeCompare(bn)
    })
    for (const id of present) {
      defs.push({ key: id, label: usersById.value.get(id)?.name ?? 'Unknown user' })
    }
  } else {
    for (const [key, option] of Object.entries(field.options ?? {})) {
      if (option.deleted) continue
      defs.push({ key, label: option.label, color: option.color })
    }
    // Values pointing at deleted/unknown options still hold cards — surface
    // them as their raw key rather than dropping the cards.
    for (const key of byColumn.keys()) {
      if (key !== VIEWS_NO_VALUE_COLUMN && !defs.some(d => d.key === key)) {
        defs.push({ key, label: key })
      }
    }
  }

  return defs.map(d => ({
    key: d.key,
    label: d.label,
    color: d.color,
    cards: orderCards(byColumn.get(d.key) ?? [], d.key)
  }))
})

// The dragged card's id, shared with every column so each can place its drop
// placeholder — dataTransfer contents are unreadable during dragover.
const draggingId = ref<string | null>(null)

function onDragStart(payload: { recordId: string }) {
  draggingId.value = payload.recordId
  emit('dragstart')
}

function onDragEnd() {
  draggingId.value = null
  emit('dragend')
}

function onDrop(columnKey: string, payload: { recordId: string, fromColumn: string | null, beforeRecordId: string | null }) {
  draggingId.value = null
  if (payload.recordId === payload.beforeRecordId) return
  const column = columns.value.find(c => c.key === columnKey)
  if (!column) return
  const ids = column.cards.map(c => c.id).filter(id => id !== payload.recordId)
  const beforeIdx = payload.beforeRecordId ? ids.indexOf(payload.beforeRecordId) : -1
  if (beforeIdx >= 0) ids.splice(beforeIdx, 0, payload.recordId)
  else ids.push(payload.recordId)
  emit('move', {
    recordId: payload.recordId,
    fromColumn: payload.fromColumn,
    toColumn: columnKey,
    columnOrder: ids
  })
}

// --- custom column management ----------------------------------------------

const columnModal = ref<{ mode: 'add' } | { mode: 'rename', key: string } | null>(null)
const columnLabel = ref('')

function openAddColumn() {
  columnLabel.value = ''
  columnModal.value = { mode: 'add' }
}

const groupColumnOpen = ref(false)
const groupColumnLabel = ref('')

function openAddGroupColumn() {
  groupColumnLabel.value = ''
  groupColumnOpen.value = true
}

function submitGroupColumn() {
  const label = groupColumnLabel.value.trim()
  if (!label) return
  if (groupField.value?.kind === 'tags') {
    if (!pendingTagColumns.value.includes(label)) pendingTagColumns.value = [...pendingTagColumns.value, label]
  } else {
    emit('addTargetColumn', label)
  }
  groupColumnOpen.value = false
}
function openRename(key: string) {
  const current = definition.value.columns?.find(c => c.key === key)
  columnLabel.value = current?.label ?? ''
  columnModal.value = { mode: 'rename', key }
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'column'
}

function submitColumnModal() {
  const label = columnLabel.value.trim()
  const modal = columnModal.value
  const existing = definition.value.columns ?? []
  if (!label || !modal) return
  if (modal.mode === 'add') {
    let key = slugify(label)
    while (existing.some(c => c.key === key)) key = `${key}-2`
    emit('columnsChange', [...existing, { key, label }])
  } else {
    emit('columnsChange', existing.map(c => c.key === modal.key ? { ...c, label } : c))
  }
  columnModal.value = null
}

function removeColumn(key: string) {
  const existing = definition.value.columns ?? []
  if (existing.length <= 1) return
  emit('columnsChange', existing.filter(c => c.key !== key))
}

// Column order is the definition array's order; moving one entry is the
// whole operation. Cards stay put — placements key off the column, not its
// position.
const draggingColumnKey = ref<string | null>(null)

function onColumnDrop({ fromKey, toKey, after }: { fromKey: string, toKey: string, after: boolean }) {
  draggingColumnKey.value = null
  const existing = definition.value.columns ?? []
  if (fromKey === toKey) return
  const from = existing.findIndex(c => c.key === fromKey)
  if (from < 0) return
  const next = [...existing]
  const [moved] = next.splice(from, 1)
  // The anchor is located after the removal, so its index already accounts
  // for the gap the dragged column left behind.
  const anchor = next.findIndex(c => c.key === toKey)
  if (anchor < 0) return
  next.splice(after ? anchor + 1 : anchor, 0, moved!)
  emit('columnsChange', next)
}

const columnModalOpen = computed({
  get: () => columnModal.value !== null,
  set: (v) => {
    if (!v) columnModal.value = null
  }
})
</script>

<template>
  <div class="flex gap-3 items-start h-full overflow-x-auto pb-2">
    <ViewsKanbanColumn
      v-for="column in columns"
      :key="column.key"
      :column="column"
      :fields="fields"
      :card-fields="cardFields"
      :card-connections="cardConnections"
      :group-field-key="groupField?.key ?? null"
      :can-quick-add="canCreate"
      :can-manage="isCustom && canEditDefinition"
      :is-custom="isCustom"
      :dragging-id="draggingId"
      :dragging-column-key="draggingColumnKey"
      @open="emit('open', $event)"
      @drop="onDrop(column.key, $event)"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @column-drag-start="draggingColumnKey = $event"
      @column-drag-end="draggingColumnKey = null"
      @column-drop="onColumnDrop"
      @quick-add="emit('quickAdd', { columnKey: column.key, name: $event })"
      @add-existing="emit('addExisting', column.key)"
      @rename="openRename(column.key)"
      @remove="removeColumn(column.key)"
      @remove-card="emit('removeCard', $event)"
    />

    <UButton
      v-if="isCustom && canEditDefinition"
      icon="i-lucide-plus"
      variant="outline"
      color="neutral"
      class="shrink-0"
      @click="openAddColumn"
    >
      Add column
    </UButton>

    <UButton
      v-if="canAddGroupColumn"
      icon="i-lucide-plus"
      variant="outline"
      color="neutral"
      class="shrink-0"
      @click="openAddGroupColumn"
    >
      {{ groupField?.kind === 'tags' ? 'Add tag' : `Add ${groupField?.label.toLowerCase() ?? 'column'}` }}
    </UButton>

    <UModal v-model:open="groupColumnOpen">
      <template #content>
        <form
          class="p-6 space-y-4"
          @submit.prevent="submitGroupColumn"
        >
          <h2 class="text-lg font-semibold">
            {{ groupField?.kind === 'tags' ? 'Add tag column' : `New ${groupField?.label.toLowerCase() ?? 'column'}` }}
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            {{ groupField?.kind === 'tags'
              ? 'Drag a card here to give it this tag.'
              : 'Creates a record that cards can be dragged into.' }}
          </p>
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="groupColumnLabel"
              autofocus
              class="w-full"
            />
          </UFormField>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="groupColumnOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :disabled="!groupColumnLabel.trim()"
            >
              Add
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <UModal v-model:open="columnModalOpen">
      <template #content>
        <form
          class="p-6 space-y-4"
          @submit.prevent="submitColumnModal"
        >
          <h2 class="text-lg font-semibold">
            {{ columnModal?.mode === 'add' ? 'Add column' : 'Rename column' }}
          </h2>
          <UFormField
            label="Label"
            required
          >
            <UInput
              v-model="columnLabel"
              autofocus
              class="w-full"
            />
          </UFormField>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="columnModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :disabled="!columnLabel.trim()"
            >
              {{ columnModal?.mode === 'add' ? 'Add' : 'Rename' }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
