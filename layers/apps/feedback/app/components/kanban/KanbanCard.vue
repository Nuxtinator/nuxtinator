<script setup lang="ts">
import type { KanbanCardModel } from './types'
import { isCardOverdue, priorityDotColor, cardPhase, phaseLabel, cardHeadline, cardLabels, labelDef, labelPillClass, feedbackType, BOARD_USERS_KEY, DOING_COLUMN } from '../../composables/useCardUtils'

const props = withDefaults(
  defineProps<{
    card: KanbanCardModel
    columnName?: string
    gridIndex?: number
  }>(),
  {
    columnName: '',
    gridIndex: 0
  }
)

const emit = defineEmits<{
  click: [card: KanbanCardModel]
  contextmenu: [payload: { card: KanbanCardModel; x: number; y: number }]
  dragstart: [payload: { card: KanbanCardModel; event: DragEvent }]
  dragend: []
}>()

const priorityQual = computed<string | null>(() => {
  const pm = props.card.post_meta || {}
  const q = pm.priority_qualitative
  if (q) return String(q).toLowerCase()
  return props.card.priority ? String(props.card.priority).toLowerCase() : null
})

const headline = computed(() => cardHeadline(props.card))
const labels = computed(() => cardLabels(props.card))
const type = computed(() => feedbackType(props.card))
const priorityDotClass = computed(() => priorityDotColor(priorityQual.value))
const overdue = computed(() => isCardOverdue(props.card, props.columnName))
const showOverdueIcon = computed(() => overdue.value && !props.card.is_done)

// Cards in the DOING column surface which workflow phase they're in.
const showPhase = computed(() => props.columnName === DOING_COLUMN)
const phaseText = computed(() => phaseLabel(cardPhase(props.card)))

const shortDueDate = computed(() => {
  if (!props.card.due_date) return ''
  const d = new Date(props.card.due_date)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
})

// Compact creation date ("Jun 19"); the full timestamp lives in the tooltip.
const createdDate = computed(() => {
  if (!props.card.created_at) return ''
  const d = new Date(props.card.created_at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
})

const createdAtFull = computed(() => {
  if (!props.card.created_at) return ''
  const d = new Date(props.card.created_at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
})

// Submitter applies only to feedback cards; prefer the captured name, fall
// back to the email, and only show "Anonymous" when neither is present.
const submitterName = computed(() => {
  if (props.card.post_type !== 'feedback') return ''
  const pm = props.card.post_meta || {}
  const name = pm.submitter_name
  if (name && String(name).trim()) return String(name).trim()
  const email = pm.submitter_email
  if (email && String(email).trim()) return String(email).trim()
  return 'Anonymous'
})

const assigneeName = computed(() => {
  const a = props.card.assignee
  return a ? String(a).trim() : ''
})

// Avatars for the submitter (matched by user id) and assignee (matched by the
// stored display name); '' when the user is unknown here or has no avatar.
const boardUsers = inject(BOARD_USERS_KEY, ref([]))
const submitterAvatar = computed(() => {
  const id = props.card.post_meta?.submitter_user_id
  return (id && boardUsers.value.find(u => u.id === id)?.avatar) || ''
})
const assigneeAvatar = computed(() =>
  (assigneeName.value && boardUsers.value.find(u => u.display_name === assigneeName.value)?.avatar) || ''
)

function handleClick() {
  emit('click', props.card)
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault()
  emit('contextmenu', { card: props.card, x: event.clientX, y: event.clientY })
}

function handleDragStart(event: DragEvent) {
  if (event.dataTransfer) {
    try {
      event.dataTransfer.setData('application/json', JSON.stringify(props.card))
    } catch {
      // parent handler receives the card anyway
    }
    event.dataTransfer.effectAllowed = 'move'
  }
  emit('dragstart', { card: props.card, event })
}

function handleDragEnd(event: DragEvent) {
  const target = event.currentTarget as HTMLElement | null
  target?.classList.remove('dragging')
  emit('dragend')
}
</script>

<template>
  <div
    class="relative rounded-md border bg-(--ui-bg-elevated) shadow-sm cursor-grab select-none
           transition-shadow duration-100
           w-full shrink-0 min-h-[84px] p-2
           hover:shadow-md hover:border-(--ui-primary)"
    :class="overdue ? 'border-red-500' : 'border-(--ui-border)'"
    draggable="true"
    :title="headline"
    @click="handleClick"
    @contextmenu.prevent="handleContextMenu"
    @dragstart="handleDragStart"
    @dragend="handleDragEnd"
  >
    <span
      v-if="showOverdueIcon"
      class="absolute top-1 left-1 text-red-500 text-[10px] leading-none"
      title="Overdue"
      aria-label="Overdue"
    >⚠️</span>

    <h4
      class="text-xs font-medium line-clamp-2 leading-snug"
      :class="{ 'pl-4': showOverdueIcon }"
      :title="headline"
    >
      {{ headline }}
    </h4>

    <div class="mt-1.5 flex items-center gap-2 text-[11px] text-(--ui-text-muted) min-w-0">
      <span
        v-if="submitterName"
        class="inline-flex items-center gap-1 min-w-0 shrink"
        :title="`Submitted by ${submitterName}`"
      >
        <UAvatar v-if="submitterAvatar" :src="submitterAvatar" :alt="submitterName" size="2xs" />
        <template v-else>
          <UIcon name="i-lucide-user" class="w-3 h-3 shrink-0" />
          <span class="truncate">{{ submitterName }}</span>
        </template>
      </span>

      <span
        v-if="createdDate"
        class="inline-flex items-center gap-0.5 shrink-0"
        :title="`Created ${createdAtFull}`"
      >
        <UIcon name="i-lucide-calendar" class="w-3 h-3" />
        <span>{{ createdDate }}</span>
      </span>

      <span
        v-if="card.due_date"
        class="inline-flex items-center gap-0.5 shrink-0"
        :class="{ 'text-red-500 font-semibold': overdue }"
        :title="card.due_date"
      >
        <UIcon :name="overdue ? 'i-lucide-triangle-alert' : 'i-lucide-calendar'" class="w-3 h-3" />
        <span>{{ shortDueDate }}</span>
      </span>

      <span
        v-if="priorityQual && priorityDotClass"
        class="inline-block w-2 h-2 rounded-full shrink-0"
        :class="[
          priorityDotClass,
          (priorityQual === 'highest' || priorityQual === 'critical') ? 'priority-pulse' : ''
        ]"
        :title="`${priorityQual.charAt(0).toUpperCase() + priorityQual.slice(1)} priority`"
      />

      <span
        v-if="card.is_done"
        class="ml-auto text-green-500 font-bold"
        title="Done"
        aria-label="Done"
      >✓</span>
    </div>

    <div
      v-if="showPhase || type || labels.length || assigneeName"
      class="mt-1.5 flex items-center flex-wrap gap-1 min-w-0"
    >
      <span
        v-if="showPhase"
        class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-(--ui-bg-accented) text-(--ui-text) shrink-0"
        :title="`Phase: ${phaseText}`"
      >
        {{ phaseText }}
      </span>
      <span
        v-if="type"
        class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium"
        :class="type.pillClass"
      >
        <UIcon :name="type.icon" class="w-3 h-3" />
        {{ type.label }}
      </span>
      <span
        v-for="l in labels"
        :key="l"
        class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
        :class="labelPillClass(l)"
      >
        {{ labelDef(l)?.label ?? l }}
      </span>

      <span
        v-if="assigneeName"
        class="ml-auto inline-flex items-center gap-1 min-w-0 shrink text-[11px] text-(--ui-text-muted)"
        :title="`Assigned to ${assigneeName}`"
      >
        <UAvatar v-if="assigneeAvatar" :src="assigneeAvatar" :alt="assigneeName" size="2xs" />
        <template v-else>
          <UIcon name="i-lucide-user-check" class="w-3 h-3 shrink-0" />
          <span class="truncate">{{ assigneeName }}</span>
        </template>
      </span>
    </div>
  </div>
</template>

<style scoped>
@keyframes flash-red {
  0%, 100% {
    background-color: rgb(220 38 38);
    opacity: 1;
  }
  50% {
    background-color: rgb(239 68 68);
    opacity: 0.6;
  }
}

.priority-pulse {
  animation: flash-red 2s ease-in-out infinite;
}
</style>
