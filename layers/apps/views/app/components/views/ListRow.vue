<script setup lang="ts">
// One row of a list tab: a done checkbox (on types with a single closed
// status), the record name, and the tab's card fields as chips. The row
// drags to reorder or into another section. Its subtasks progress links to
// the board of those subtasks.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsConnectionDisplay } from '../../utils/views-types'

const props = defineProps<{
  item: ViewsBoardItem
  fields: RecordsFieldSetting[]
  cardFields: string[]
  cardConnections?: Record<string, ViewsConnectionDisplay>
  groupFieldKey: string | null
  /** null hides the checkbox. */
  done: boolean | null
  /** Shown while another row is dragged over this one. */
  dropBefore: boolean
  removable: boolean
}>()

const emit = defineEmits<{
  open: [recordId: string]
  toggle: [done: boolean]
  remove: []
  dragstart: [event: DragEvent]
  dragend: []
}>()

const { byId } = useRecordsUsers()
const displayName = (id: string) => byId.value.get(id)?.name ?? 'Unknown user'
const NuxtLink = resolveComponent('NuxtLink')
const { boardRoute } = useViewsSubtasksBoard()

// A status chip repeats what the checkbox already says.
const shownFields = computed(() =>
  props.done === null ? props.cardFields : props.cardFields.filter(k => k !== 'status'))

const values = useViewsCardValues(() => ({
  item: props.item,
  fields: props.fields,
  cardFields: shownFields.value,
  cardConnections: props.cardConnections,
  groupFieldKey: props.groupFieldKey
}))

const menuItems = computed(() => props.removable
  ? [[props.item.ownCard
      ? { label: 'Delete card', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('remove') }
      : { label: 'Remove from view', icon: 'i-lucide-x', onSelect: () => emit('remove') }]]
  : [])
</script>

<template>
  <div
    draggable="true"
    class="group relative flex items-center gap-3 px-3 py-2 border-b border-(--ui-border) bg-(--ui-bg) hover:bg-(--ui-bg-elevated)/50 cursor-grab active:cursor-grabbing"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend')"
  >
    <div
      v-if="dropBefore"
      class="absolute inset-x-0 -top-px h-0.5 bg-(--ui-primary)"
    />
    <UCheckbox
      v-if="done !== null"
      :model-value="done"
      :aria-label="done ? 'Mark as not done' : 'Mark as done'"
      @update:model-value="emit('toggle', $event === true)"
      @click.stop
    />
    <button
      type="button"
      class="flex-1 min-w-0 text-left text-sm truncate"
      :class="done ? 'line-through text-(--ui-text-muted)' : ''"
      @click="emit('open', item.id)"
    >
      {{ item.name }}
    </button>
    <div class="flex items-center gap-1.5 shrink-0 max-w-[55%] overflow-hidden">
      <template
        v-for="value in values"
        :key="value.key"
      >
        <span
          v-if="value.userIds"
          class="inline-flex items-center gap-1"
          :title="value.userIds.map(displayName).join(', ')"
        >
          <UAvatar
            v-for="id in value.userIds.slice(0, 3)"
            :key="id"
            v-bind="userAvatarProps({ id, name: byId.get(id)?.name, image: byId.get(id)?.avatarUrl })"
            :alt="displayName(id)"
            size="2xs"
          />
        </span>
        <component
          :is="value.drill ? NuxtLink : 'span'"
          v-else-if="value.progress"
          :to="value.drill ? boardRoute(item.id) : undefined"
          :title="value.drill ? `Open the ${value.label.toLowerCase()} board` : undefined"
          class="inline-flex items-center gap-1 text-xs text-(--ui-text-muted) tabular-nums"
          :class="value.drill ? 'rounded px-1 hover:bg-(--ui-bg-elevated) hover:text-(--ui-text)' : ''"
        >
          <UProgress
            :model-value="value.progress.done"
            :max="value.progress.total"
            size="xs"
            class="w-12"
          />
          {{ value.text }}
          <UIcon
            v-if="value.drill"
            name="i-lucide-chevron-right"
            class="size-3.5 text-(--ui-text-dimmed)"
          />
        </component>
        <UBadge
          v-else
          variant="subtle"
          color="neutral"
          size="sm"
          class="truncate"
          :title="value.label"
        >
          {{ value.text }}
        </UBadge>
      </template>
    </div>
    <UDropdownMenu
      v-if="menuItems.length > 0"
      :items="menuItems"
    >
      <UButton
        icon="i-lucide-ellipsis"
        variant="ghost"
        color="neutral"
        size="xs"
        class="opacity-0 group-hover:opacity-100"
        aria-label="Row options"
        @click.stop
      />
    </UDropdownMenu>
  </div>
</template>
