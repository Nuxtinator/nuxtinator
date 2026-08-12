<script setup lang="ts">
// One kanban column: header (label, count, management menu on custom
// boards), the card stack with drop handling, and quick-add. Drop position:
// over a card, the pointer's half decides whether the card lands before or
// after it; over the column body it appends — the board turns that into a
// columnOrder for the move call. A placeholder marks the landing spot for as
// long as a card hovers the column, computed the same way as the drop, so
// the card lands where the gap showed.
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
  /** Record id currently being dragged anywhere on the board, if any. */
  draggingId: string | null
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
// Where a drop would land right now: the id of the card it would go before,
// null for the end of the stack, undefined while nothing hovers this column.
const dropBefore = ref<string | null | undefined>(undefined)

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
  dropBefore.value = null
}

/**
 * The card a drop over `card` would land before — itself when the pointer is
 * in its top half, the next one when it's in the bottom half (null past the
 * last card, i.e. append).
 */
function dropTargetFor(event: DragEvent, card: WorkflowsBoardItem, index: number): string | null {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (event.clientY <= rect.top + rect.height / 2) return card.id
  return props.column.cards[index + 1]?.id ?? null
}

// Stops at the card so the column's own handler can't overwrite the landing
// spot on the way up.
function onCardDragOver(event: DragEvent, card: WorkflowsBoardItem, index: number) {
  event.stopPropagation()
  onDragOver(event)
  dropBefore.value = dropTargetFor(event, card, index)
}

// The placeholder takes the space the pointer was just over, so it has to
// hold the landing spot itself — otherwise the event would reach the column
// body, reset the spot to "append", and the placeholder would flicker
// between the two positions.
function onPlaceholderDragOver(event: DragEvent, cardId: string) {
  event.stopPropagation()
  onDragOver(event)
  dropBefore.value = cardId
}

function onDropOnPlaceholder(event: DragEvent, cardId: string) {
  event.preventDefault()
  event.stopPropagation()
  dragOver.value = false
  dropBefore.value = undefined
  const payload = readPayload(event)
  if (payload) emit('drop', { ...payload, beforeRecordId: cardId })
}

function onDragLeave(event: DragEvent) {
  if (event.currentTarget === event.target) {
    dragOver.value = false
    dropBefore.value = undefined
  }
}

function onDropOnCard(event: DragEvent, card: WorkflowsBoardItem, index: number) {
  event.preventDefault()
  event.stopPropagation()
  const beforeRecordId = dropTargetFor(event, card, index)
  dragOver.value = false
  dropBefore.value = undefined
  const payload = readPayload(event)
  if (payload) emit('drop', { ...payload, beforeRecordId })
}

function onDropOnColumn(event: DragEvent) {
  event.preventDefault()
  dragOver.value = false
  dropBefore.value = undefined
  const payload = readPayload(event)
  if (payload) emit('drop', { ...payload, beforeRecordId: null })
}

function onCardDragEnd() {
  dragOver.value = false
  dropBefore.value = undefined
  emit('dragend')
}

// A placeholder only earns its space when the drop would actually move the
// card — dropping a card immediately before itself changes nothing.
function showPlaceholderBefore(cardId: string): boolean {
  return !!props.draggingId && dropBefore.value === cardId && props.draggingId !== cardId
}

const showPlaceholderAtEnd = computed(() => {
  if (!props.draggingId || dropBefore.value !== null) return false
  const last = props.column.cards[props.column.cards.length - 1]
  return last?.id !== props.draggingId
})

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

    <!-- Card spacing is the wrappers' own padding rather than a gap between
         them, so moving down the stack never crosses a strip that belongs to
         no card and the placeholder can't flicker to the end. -->
    <div class="flex-1 overflow-y-auto px-2 pb-2 min-h-16">
      <template
        v-for="(card, index) in column.cards"
        :key="card.id"
      >
        <div
          v-if="showPlaceholderBefore(card.id)"
          class="h-10 mb-2 rounded-lg border-2 border-dashed border-(--ui-primary) bg-(--ui-primary)/5"
          @dragover="onPlaceholderDragOver($event, card.id)"
          @drop="onDropOnPlaceholder($event, card.id)"
        />
        <div
          class="pb-2"
          @dragover="onCardDragOver($event, card, index)"
          @drop="onDropOnCard($event, card, index)"
        >
          <div class="group relative">
            <WorkflowsKanbanCard
              :item="card"
              :fields="fields"
              :card-fields="cardFields"
              :group-field-key="groupFieldKey"
              @open="emit('open', $event)"
              @dragstart="onCardDragStart($event, card)"
              @dragend="onCardDragEnd"
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
      </template>
      <div
        v-if="showPlaceholderAtEnd"
        class="h-10 rounded-lg border-2 border-dashed border-(--ui-primary) bg-(--ui-primary)/5"
      />
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
