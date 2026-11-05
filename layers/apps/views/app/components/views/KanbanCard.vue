<script setup lang="ts">
// One card: record name plus the view's chosen card fields, in the order the
// view chose. Values come from the record row (status, timestamps, jsonb
// fields), from the board's grouping values, or from the side-table values
// the feed attaches for the chosen keys — so any field of the type can be
// shown. User fields render as each person's avatar beside their name;
// connection fields as names, a count, or done-progress, per the layout.
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
const userName = (id: string) => byId.value.get(id)?.name ?? null

// People are named, not just pictured: an image avatar is often missing and
// initials alone can't tell two same-initial colleagues apart.
const displayName = (id: string) => byId.value.get(id)?.name ?? 'Unknown user'

// Beyond a handful the names stop fitting; the rest show as a count.
const USER_CAP = 3

const fieldMap = computed(() => new Map(props.fields.map(f => [f.key, f])))

const INTRINSIC_DEFS: Record<string, Pick<RecordsFieldSetting, 'key' | 'kind' | 'label'>> = {
  created_at: { key: 'created_at', kind: 'datetime', label: 'Created' },
  updated_at: { key: 'updated_at', kind: 'datetime', label: 'Updated' }
}

interface CardValue {
  key: string
  label: string
  text: string
  /** Set for user fields — rendered as avatars in place of the text. */
  userIds?: string[]
  /** Set for connection fields shown as progress — rendered as a bar. */
  progress?: { done: number, total: number }
}

function userIdsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

const values = computed<CardValue[]>(() => {
  const out: CardValue[] = []
  for (const key of props.cardFields) {
    if (key === 'name') continue
    const intrinsic = INTRINSIC_DEFS[key]
    if (intrinsic) {
      const raw = key === 'created_at' ? props.item.createdAt : props.item.updatedAt
      const text = formatRecordsValue(raw, intrinsic as RecordsFieldSetting)
      if (text && text !== '—') out.push({ key, label: intrinsic.label, text })
      continue
    }
    const field = fieldMap.value.get(key)
      ?? (key === 'status' ? props.fields.find(f => f.column === 'status') : undefined)
    if (!field) continue
    let raw: unknown = null
    if (field.column === 'status' || key === 'status') raw = props.item.status
    else if (viewsFieldStorage(field) === 'jsonb') raw = props.item.data[field.key]
    else if (props.item.fields && field.key in props.item.fields) raw = props.item.fields[field.key]
    else if (field.key === props.groupFieldKey) raw = props.item.groupValues
    else raw = null

    const display = props.cardConnections?.[field.key]
    const progress = props.item.progress?.[field.key]
    if (field.kind === 'connection' && progress && (display === 'count' || display === 'progress')) {
      if (progress.total === 0) continue
      if (display === 'count') out.push({ key, label: field.label, text: String(progress.total) })
      else out.push({ key, label: field.label, text: `${progress.done}/${progress.total}`, progress })
      continue
    }

    if (field.kind === 'user_select') {
      const userIds = userIdsOf(raw)
      if (userIds.length > 0) out.push({ key, label: field.label, text: '', userIds })
      continue
    }
    const text = formatRecordsValue(raw, field, { userName })
    if (text && text !== '—') out.push({ key, label: field.label, text })
  }
  return out
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
