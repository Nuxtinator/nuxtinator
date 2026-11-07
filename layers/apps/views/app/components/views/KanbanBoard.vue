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
// - Custom: columns come from the tab definition; membership from
//   placements. A card with no placement, or one pointing at a removed
//   column, renders in the first column of a hand-picked view, or in a
//   leading "No column" lane otherwise, so no card silently disappears.
//   Only a hand-picked view adds existing records to the board or takes
//   them off it.
import type { RecordsFieldSetting } from '#records/client'
import type {
  ViewsColumnDef,
  ViewsTabView,
  ViewRecords
} from '../../utils/views-types'
import { VIEWS_NO_VALUE_COLUMN } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
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

const { ensureUsers } = useRecordsUsers()

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

const columns = useViewsColumns(() => ({
  definition: definition.value,
  picked: props.view.picked,
  records: props.records,
  fields: props.fields,
  pendingTagColumns: pendingTagColumns.value
}))

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
  // A hand-picked view's cards need a column to sit in; elsewhere they fall
  // back to "No column".
  if (props.view.picked && existing.length <= 1) return
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
      :can-manage="isCustom && canEditDefinition && column.key !== VIEWS_NO_VALUE_COLUMN"
      :is-custom="isCustom"
      :picked="view.picked"
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
