<script setup lang="ts">
// One card: record name plus the view's chosen card fields. Only values the
// list feed actually carries render — jsonb-stored fields, the promoted
// status, timestamps, and the grouping field's values; other storages would
// need per-record hydration and are skipped (same limitation as CRM's list
// table). Assigned users show as an avatar row when present.
import type { CrmFieldSetting } from '../../../../crm/app/utils/field-kinds'
import type { WorkflowsBoardItem } from '../../utils/workflows-types'

const props = defineProps<{
  item: WorkflowsBoardItem
  fields: CrmFieldSetting[]
  cardFields: string[]
  /** The board's grouping field key, whose values ride on groupValues. */
  groupFieldKey: string | null
}>()

const emit = defineEmits<{
  open: [recordId: string]
  dragstart: [event: DragEvent]
  dragend: []
}>()

const { byId, ensureUsers } = useCrmUsers()
onMounted(() => {
  ensureUsers().catch(() => {
    // Avatars fall back to ids; nothing to surface on a card.
  })
})
const userName = (id: string) => byId.value.get(id)?.name ?? null

const fieldMap = computed(() => new Map(props.fields.map(f => [f.key, f])))

const INTRINSIC_DEFS: Record<string, Pick<CrmFieldSetting, 'key' | 'kind' | 'label'>> = {
  created_at: { key: 'created_at', kind: 'datetime', label: 'Created' },
  updated_at: { key: 'updated_at', kind: 'datetime', label: 'Updated' }
}

interface CardValue {
  key: string
  label: string
  text: string
}

const values = computed<CardValue[]>(() => {
  const out: CardValue[] = []
  for (const key of props.cardFields) {
    if (key === 'name') continue
    const intrinsic = INTRINSIC_DEFS[key]
    if (intrinsic) {
      const raw = key === 'created_at' ? props.item.createdAt : props.item.updatedAt
      const text = formatCrmValue(raw, intrinsic as CrmFieldSetting)
      if (text && text !== '—') out.push({ key, label: intrinsic.label, text })
      continue
    }
    const field = fieldMap.value.get(key)
      ?? (key === 'status' ? props.fields.find(f => f.column === 'status') : undefined)
    if (!field) continue
    let raw: unknown = null
    if (field.column === 'status' || key === 'status') raw = props.item.status
    else if (workflowsFieldStorage(field) === 'jsonb') raw = props.item.data[field.key]
    else if (field.key === props.groupFieldKey) raw = props.item.groupValues
    else continue
    const text = formatCrmValue(raw, field, { userName })
    if (text && text !== '—') out.push({ key, label: field.label, text })
  }
  return out
})

const assignedUsers = computed(() =>
  props.item.assignedTo.map(id => byId.value.get(id) ?? null))

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
        class="flex items-baseline gap-1.5 text-xs"
      >
        <dt class="text-(--ui-text-dimmed) shrink-0">
          {{ value.label }}
        </dt>
        <dd class="text-(--ui-text-muted) truncate">
          {{ value.text }}
        </dd>
      </div>
    </dl>
    <div
      v-if="assignedUsers.length > 0"
      class="flex -space-x-1.5 pt-0.5"
    >
      <UAvatar
        v-for="(assignee, i) in assignedUsers.slice(0, 5)"
        :key="i"
        :src="assignee?.avatarUrl ?? undefined"
        :alt="assignee?.name ?? 'Unknown user'"
        size="3xs"
        class="ring-1 ring-(--ui-bg)"
      />
    </div>
  </button>
</template>
