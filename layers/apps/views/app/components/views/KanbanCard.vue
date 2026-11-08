<script setup lang="ts">
// One card: record name plus the view's chosen card fields, in the order the
// view chose. Values come from the record row (status, timestamps, jsonb
// fields), from the board's grouping values, or from the side-table values
// the feed attaches for the chosen keys — so any field of the type can be
// shown. User fields render as each person's avatar beside their name;
// connection fields as names, a count, or done-progress, per the layout. A
// cover field's first image tops the card.
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
// People are named, not just pictured: an image avatar is often missing and
// initials alone can't tell two same-initial colleagues apart.
const displayName = (id: string) => byId.value.get(id)?.name ?? 'Unknown user'

// Beyond a handful the names stop fitting; the rest show as a count.
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
        class="flex gap-1.5 text-xs"
        :class="value.userIds ? 'items-start' : 'items-baseline'"
      >
        <dt class="text-(--ui-text-dimmed) shrink-0">
          {{ value.label }}
        </dt>
        <dd
          v-if="value.userIds"
          class="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0"
        >
          <span
            v-for="id in value.userIds.slice(0, USER_CAP)"
            :key="id"
            class="inline-flex items-center gap-1 min-w-0"
          >
            <UAvatar
              :src="byId.get(id)?.avatarUrl ?? undefined"
              :alt="displayName(id)"
              size="3xs"
            />
            <span class="text-(--ui-text-muted) truncate">{{ displayName(id) }}</span>
          </span>
          <span
            v-if="value.userIds.length > USER_CAP"
            class="text-(--ui-text-dimmed)"
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
