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
// Fields the tab keeps on its cards when empty show as "Add <field>" until
// set, and clicking one, set or not, opens its editor on the card.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsConnectionDisplay } from '../../utils/views-types'
import CardFieldPopover from './CardFieldPopover.vue'

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
  /** Card fields kept on the card when empty, and set from it. */
  showEmpty?: string[]
  /** The caller can change the view's own fields. */
  canEditViewFields?: boolean
  /** The record type, for the tags editor's suggestions. */
  typeKey?: string
}>()

const emit = defineEmits<{
  open: [recordId: string]
  dragstart: [event: DragEvent]
  dragend: []
  /** A field was set from the card; `previous` is the value its editor showed. */
  setField: [payload: { field: RecordsFieldSetting, value: unknown, previous: unknown }]
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

function editorProps(edit: { field: RecordsFieldSetting, value: unknown }) {
  const suggestUrl = edit.field.kind === 'tags' && props.typeKey && !viewsIsViewField(edit.field)
    ? `/api/records/entries/${props.typeKey}/tags?field=${edit.field.key}`
    : undefined
  return { field: edit.field, value: edit.value, suggestUrl }
}
</script>

<template>
  <button
    type="button"
    draggable="true"
    class="w-full text-left rounded-lg border border-(--ui-border) bg-(--ui-bg) px-3 py-2 space-y-1 shadow-xs hover:border-(--ui-border-accented) cursor-grab active:cursor-grabbing transition-colors"
    :class="item.pending ? 'opacity-60 pointer-events-none' : ''"
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
      <component
        :is="value.edit ? CardFieldPopover : 'div'"
        v-for="value in values"
        :key="value.key"
        v-bind="value.edit ? editorProps(value.edit) : {}"
        class="flex items-center gap-1.5 text-xs"
        :class="value.drill || value.edit ? '-mx-1 px-1 rounded cursor-pointer hover:bg-(--ui-bg-elevated)' : ''"
        :title="value.drill ? `Open the ${value.label.toLowerCase()} board` : undefined"
        @click="value.drill && onDrill($event)"
        @commit="(next: unknown, previous: unknown) => value.edit && emit('setField', { field: value.edit.field, value: next, previous })"
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
          v-if="value.empty"
          class="text-(--ui-text-dimmed) truncate"
        >
          Add {{ value.label }}
        </dd>
        <dd
          v-else-if="value.userIds"
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
          class="truncate"
          :class="value.tone === 'error' ? 'text-(--ui-error) font-medium' : value.tone === 'warning' ? 'text-(--ui-warning) font-medium' : 'text-(--ui-text-muted)'"
        >
          {{ value.text }}
        </dd>
      </component>
    </dl>
  </button>
</template>
