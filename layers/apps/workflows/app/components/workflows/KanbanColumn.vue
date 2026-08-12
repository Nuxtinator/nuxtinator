<script setup lang="ts">
// One kanban column: header (label, count, management menu on custom
// boards), the card stack with drop handling, and quick-add. Drop position:
// dropping on a card inserts before it, dropping on the column body
// appends — the board turns that into a columnOrder for the move call.
import type { CrmFieldSetting, CrmBadgeColor } from '../../../../crm/app/utils/field-kinds'
import type { WorkflowsBoardItem } from '../../utils/workflows-types'

export interface WorkflowsBoardColumn {
  key: string
  label: string
  color?: CrmBadgeColor | string
  cards: WorkflowsBoardItem[]
}

const props = defineProps<{
  column: WorkflowsBoardColumn
  fields: CrmFieldSetting[]
  cardFields: string[]
  groupFieldKey: string | null
  /** Caller may create records of this type (server re-enforces). */
  canQuickAdd: boolean
  /** Custom board + edit access: rename/remove column, add existing cards. */
  canManage: boolean
  isCustom: boolean
  /** Manageable and not already the first column of the board. */
  canMoveLeft: boolean
  /** Manageable and not already the last column of the board. */
  canMoveRight: boolean
}>()

const emit = defineEmits<{
  open: [recordId: string]
  drop: [payload: { recordId: string, fromColumn: string | null, beforeRecordId: string | null }]
  dragstart: [payload: { recordId: string, fromColumn: string }]
  dragend: []
  quickAdd: [name: string]
  rename: []
  remove: []
  /** Shift this column one position: -1 left, +1 right. */
  reorder: [delta: number]
  addExisting: []
  removeCard: [recordId: string]
}>()

const dragOver = ref(false)

function onCardDragStart(event: DragEvent, card: WorkflowsBoardItem) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('application/json', JSON.stringify({
    recordId: card.id,
    fromColumn: props.column.key
  }))
  event.dataTransfer.effectAllowed = 'move'
  emit('dragstart', { recordId: card.id, fromColumn: props.column.key })
}

function readPayload(event: DragEvent): { recordId: string, fromColumn: string | null } | null {
  const raw = event.dataTransfer?.getData('application/json')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { recordId?: unknown, fromColumn?: unknown }
    if (typeof parsed.recordId !== 'string') return null
    return {
      recordId: parsed.recordId,
      fromColumn: typeof parsed.fromColumn === 'string' ? parsed.fromColumn : null
    }
  } catch {
    return null
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOver.value = true
}

function onDragLeave(event: DragEvent) {
  if (event.currentTarget === event.target) dragOver.value = false
}

function onDropOnCard(event: DragEvent, card: WorkflowsBoardItem) {
  event.preventDefault()
  event.stopPropagation()
  dragOver.value = false
  const payload = readPayload(event)
  if (payload) emit('drop', { ...payload, beforeRecordId: card.id })
}

function onDropOnColumn(event: DragEvent) {
  event.preventDefault()
  dragOver.value = false
  const payload = readPayload(event)
  if (payload) emit('drop', { ...payload, beforeRecordId: null })
}

// --- quick add -------------------------------------------------------------

const quickAddOpen = ref(false)
const quickAddName = ref('')
const quickAddBusy = ref(false)

async function submitQuickAdd() {
  const value = quickAddName.value.trim()
  if (!value || quickAddBusy.value) return
  quickAddBusy.value = true
  try {
    emit('quickAdd', value)
    quickAddName.value = ''
  } finally {
    quickAddBusy.value = false
  }
}

const badgeColor = computed<CrmBadgeColor>(() => {
  const raw = props.column.color
  const known: CrmBadgeColor[] = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']
  return known.includes(raw as CrmBadgeColor) ? raw as CrmBadgeColor : 'neutral'
})

const menuItems = computed(() => {
  const move: Array<Record<string, unknown>> = []
  if (props.canMoveLeft) {
    move.push({ label: 'Move left', icon: 'i-lucide-arrow-left', onSelect: () => emit('reorder', -1) })
  }
  if (props.canMoveRight) {
    move.push({ label: 'Move right', icon: 'i-lucide-arrow-right', onSelect: () => emit('reorder', 1) })
  }
  return [
    [
      { label: 'Add existing record', icon: 'i-lucide-search', onSelect: () => emit('addExisting') },
      { label: 'Rename column', icon: 'i-lucide-pencil', onSelect: () => emit('rename') }
    ],
    ...(move.length > 0 ? [move] : []),
    [{ label: 'Remove column', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('remove') }]
  ]
})
</script>

<template>
  <section
    class="flex flex-col w-72 shrink-0 max-h-full rounded-xl border bg-(--ui-bg-muted)/50 transition-colors"
    :class="dragOver ? 'border-(--ui-primary)' : 'border-(--ui-border)'"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDropOnColumn"
  >
    <header class="flex items-center gap-2 px-3 py-2">
      <UBadge
        :color="badgeColor"
        variant="subtle"
        class="max-w-full"
      >
        <span class="truncate">{{ column.label }}</span>
      </UBadge>
      <span class="text-xs text-(--ui-text-dimmed)">{{ column.cards.length }}</span>
      <span class="flex-1" />
      <UDropdownMenu
        v-if="canManage"
        :items="menuItems"
      >
        <UButton
          icon="i-lucide-ellipsis"
          variant="ghost"
          color="neutral"
          size="xs"
          aria-label="Column options"
        />
      </UDropdownMenu>
    </header>

    <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-16">
      <div
        v-for="card in column.cards"
        :key="card.id"
        @dragover="onDragOver"
        @drop="onDropOnCard($event, card)"
      >
        <div class="group relative">
          <WorkflowsKanbanCard
            :item="card"
            :fields="fields"
            :card-fields="cardFields"
            :group-field-key="groupFieldKey"
            @open="emit('open', $event)"
            @dragstart="onCardDragStart($event, card)"
            @dragend="emit('dragend')"
          />
          <UButton
            v-if="isCustom && canManage"
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="xs"
            aria-label="Remove from board"
            class="absolute top-1 right-1 opacity-0 group-hover:opacity-100"
            @click.stop="emit('removeCard', card.id)"
          />
        </div>
      </div>
    </div>

    <footer
      v-if="canQuickAdd"
      class="p-2 pt-0"
    >
      <form
        v-if="quickAddOpen"
        @submit.prevent="submitQuickAdd"
      >
        <UInput
          v-model="quickAddName"
          autofocus
          size="sm"
          class="w-full"
          placeholder="Record name…"
          :disabled="quickAddBusy"
          @keydown.esc="quickAddOpen = false"
          @blur="!quickAddName && (quickAddOpen = false)"
        />
      </form>
      <UButton
        v-else
        icon="i-lucide-plus"
        variant="ghost"
        color="neutral"
        size="sm"
        class="w-full justify-start"
        @click="quickAddOpen = true"
      >
        Add card
      </UButton>
    </footer>
  </section>
</template>
