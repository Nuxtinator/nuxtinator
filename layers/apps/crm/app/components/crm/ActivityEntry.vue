<script setup lang="ts">
// One activity row: action icon, actor name + human sentence, an old→new
// value line for field changes, the write-time note when present, and a
// relative timestamp. Field settings resolve labels and kind-aware value
// formatting; unknown fields (deleted/orphan) fall back to the raw key and
// a JSON rendering of the snapshot.
import type { CrmActivityItem } from '../../composables/useCrmTimeline'
import type { CrmFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  activity: CrmActivityItem
  /** Merged field settings of the record's type. */
  fields: CrmFieldSetting[]
}>()

const { userName } = useCrmUsers()

const ACTION_ICONS: Record<string, string> = {
  created: 'i-lucide-sparkles',
  field_changed: 'i-lucide-pencil-line',
  channel_linked: 'i-lucide-link',
  channel_unlinked: 'i-lucide-unlink',
  consent_changed: 'i-lucide-shield-check',
  shared: 'i-lucide-user-plus',
  unshared: 'i-lucide-user-minus',
  deleted: 'i-lucide-trash-2'
}

const icon = computed(() => ACTION_ICONS[props.activity.action] ?? 'i-lucide-activity')

const fieldDef = computed(() =>
  props.activity.fieldKey
    ? props.fields.find(f => f.key === props.activity.fieldKey) ?? null
    : null
)

const fieldLabel = computed(() => fieldDef.value?.label ?? props.activity.fieldKey ?? '')

function formatSnapshot(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const def = fieldDef.value
  if (def) return formatCrmValue(value, def, { userName })
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

// Channel activity snapshots carry { channel_id, channel_type, value }.
function channelValue(snapshot: unknown): string {
  const value = (snapshot as { value?: unknown } | null)?.value
  return typeof value === 'string' ? value : ''
}

const sentence = computed(() => {
  const a = props.activity
  switch (a.action) {
    case 'created':
      return 'created this record'
    case 'field_changed':
      return `changed ${fieldLabel.value}`
    case 'channel_linked': {
      const value = channelValue(a.newValue)
      return value ? `added ${value}` : `added a ${fieldLabel.value} entry`
    }
    case 'channel_unlinked': {
      const value = channelValue(a.oldValue)
      return value ? `removed ${value}` : `removed a ${fieldLabel.value} entry`
    }
    case 'consent_changed':
      return 'updated consent'
    case 'shared':
      return 'shared this record'
    case 'unshared':
      return 'removed a share'
    case 'deleted':
      return 'deleted this record'
    default:
      // Freeform system actions read as words; their detail lives in `note`.
      return a.action.replaceAll('_', ' ')
  }
})

const showValues = computed(() => props.activity.action === 'field_changed')
</script>

<template>
  <div class="flex gap-3 px-4 py-3">
    <div class="mt-0.5 grid place-items-center size-6 shrink-0 rounded-full bg-(--ui-bg-elevated)">
      <UIcon
        :name="icon"
        class="size-3.5 text-(--ui-text-muted)"
      />
    </div>
    <div class="min-w-0 flex-1 space-y-1">
      <p class="text-sm text-(--ui-text-muted)">
        <span class="font-medium text-(--ui-text)">{{ activity.actorName }}</span>
        {{ sentence }}
        <span
          v-if="activity.viaClient"
          class="text-xs whitespace-nowrap"
        > · via {{ activity.viaClient }}</span>
        <span class="text-xs whitespace-nowrap"> · {{ crmRelativeTime(activity.createdAt) }}</span>
      </p>
      <p
        v-if="showValues"
        class="text-sm break-words"
      >
        <span class="text-(--ui-text-muted) line-through">{{ formatSnapshot(activity.oldValue) }}</span>
        <UIcon
          name="i-lucide-arrow-right"
          class="size-3 mx-1.5 inline-block align-middle text-(--ui-text-muted)"
        />
        <span>{{ formatSnapshot(activity.newValue) }}</span>
      </p>
      <p
        v-if="activity.note"
        class="text-sm text-(--ui-text-muted) break-words"
      >
        {{ activity.note }}
      </p>
    </div>
  </div>
</template>
