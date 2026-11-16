<script setup lang="ts">
// One card: record name plus the view's chosen card fields, in the order the
// view chose, each led by its field's icon with the label on hover. Values
// come from the record row (status, timestamps, jsonb
// fields), from the board's grouping values, or from the side-table values
// the feed attaches for the chosen keys — so any field of the type can be
// shown. User fields render as each person's avatar, named on hover;
// connection fields as names, a count, or done-progress, per the layout. A
// cover field's first image tops the card. Clicking the card opens its
// details; clicking its subtasks value opens the board of those subtasks.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsConnectionDisplay } from '../../utils/views-types'

const props = defineProps<{
  item: ViewsBoardItem
  fields: RecordsFieldSetting[]
  cardFields: string[]
  /** How each connection card field shows; unlisted ones show names. */
  cardConnections?: Record<string, ViewsConnectionDisplay>
  /** The board's grouping field key, whose values ride on groupValues. */
  groupFieldKey: string | null
  /** An attachments field whose first image tops the card. */
  coverKey?: string | null
}>()

const emit = defineEmits<{
  open: [recordId: string]
  dragstart: [event: DragEvent]
  dragend: []
}>()

const { byId, ensureUsers } = useRecordsUsers()
onMounted(() => {
  ensureUsers().catch(() => {
    // Avatars fall back to ids; nothing to surface on a card.
  })
})
const displayName = (id: string) => byId.value.get(id)?.name ?? 'Unknown user'

// Beyond a handful the avatars crowd the card; the rest show as a count.
const USER_CAP = 3

const values = useViewsCardValues(() => props)

const cover = computed(() => {
  if (!props.coverKey) return null
  const raw = props.item.fields?.[props.coverKey] ?? props.item.viewValues?.[props.coverKey]
  return recordsAttachmentList(raw).find(recordsIsImage) ?? null
})

function onDragStart(event: DragEvent) {
  emit('dragstart', event)
}

// The subtasks value opens the card's own board instead of its details.
const { openBoard } = useViewsSubtasksBoard()
function onDrill(event: MouseEvent) {
  event.stopPropagation()
  openBoard(props.item.id)
}
</script>

<template>
  <button
    type="button"
    draggable="true"
    class="w-full text-left rounded-lg border border-(--ui-border) bg-(--ui-bg) px-3 py-2 space-y-1 shadow-xs hover:border-(--ui-border-accented) cursor-grab active:cursor-grabbing transition-colors"
    @click="emit('open', item.id)"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
    <img
      v-if="cover"
      :src="cover.url"
      :alt="cover.name"
      loading="lazy"
      class="-mx-3 -mt-2 mb-2 w-[calc(100%+1.5rem)] max-w-none h-32 object-cover rounded-t-lg"
    >
    <p class="text-sm font-medium leading-snug">
      {{ item.name }}
    </p>
    <dl
      v-if="values.length > 0"
      class="space-y-0.5"
    >
      <div
        v-for="value in values"
        :key="value.key"
        class="flex items-center gap-1.5 text-xs"
        :class="value.drill ? '-mx-1 px-1 rounded cursor-pointer hover:bg-(--ui-bg-elevated)' : ''"
        :title="value.drill ? `Open the ${value.label.toLowerCase()} board` : undefined"
        @click="value.drill && onDrill($event)"
      >
        <dt
          class="flex shrink-0 text-(--ui-text-dimmed)"
          :title="value.label"
        >
          <UIcon
            :name="value.icon"
            class="size-3.5"
          />
          <span class="sr-only">{{ value.label }}</span>
        </dt>
        <dd
          v-if="value.userIds"
          class="flex items-center gap-1 min-w-0"
        >
          <UAvatar
            v-for="id in value.userIds.slice(0, USER_CAP)"
            :key="id"
            v-bind="userAvatarProps({ id, name: byId.get(id)?.name, image: byId.get(id)?.avatarUrl })"
            :alt="displayName(id)"
            :title="displayName(id)"
            size="2xs"
          />
          <span
            v-if="value.userIds.length > USER_CAP"
            class="text-(--ui-text-dimmed)"
            :title="value.userIds.slice(USER_CAP).map(displayName).join(', ')"
          >
            +{{ value.userIds.length - USER_CAP }}
          </span>
        </dd>
        <dd
          v-else-if="value.progress"
          class="flex items-center gap-1.5 min-w-0 flex-1"
        >
          <UProgress
            :model-value="value.progress.done"
            :max="value.progress.total"
            size="xs"
            class="flex-1 max-w-24"
          />
          <span class="text-(--ui-text-muted) tabular-nums">{{ value.text }}</span>
          <UIcon
            v-if="value.drill"
            name="i-lucide-chevron-right"
            class="size-3.5 text-(--ui-text-dimmed) ml-auto shrink-0"
          />
        </dd>
        <dd
          v-else
          class="text-(--ui-text-muted) truncate"
        >
          {{ value.text }}
        </dd>
      </div>
    </dl>
  </button>
</template>
