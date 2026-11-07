<script setup lang="ts">
// Ordered field list for the type editor. Rows open the field editor;
// up/down buttons reorder (the page persists order overrides); the switch
// toggles visibility in place. Custom fields (admin-created) and stale
// orphan rows are badged so managers can tell code schema from DB schema.
import type { RecordsFieldSetting, RecordsTypeSections } from '../../../utils/field-kinds'

const props = defineProps<{
  fields: RecordsFieldSetting[]
  sections: RecordsTypeSections
  busy?: boolean
}>()

const emit = defineEmits<{
  edit: [field: RecordsFieldSetting]
  move: [field: RecordsFieldSetting, dir: -1 | 1]
  toggleHidden: [field: RecordsFieldSetting, hidden: boolean]
}>()

function sectionLabel(field: RecordsFieldSetting): string | null {
  if (!field.section) return null
  return props.sections[field.section]?.label ?? field.section
}
</script>

<template>
  <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
    <li
      v-for="(field, index) in fields"
      :key="field.key"
      class="flex items-center gap-3 px-3 py-2 hover:bg-(--ui-bg-elevated)/50 cursor-pointer"
      @click="emit('edit', field)"
    >
      <div
        class="flex flex-col shrink-0"
        @click.stop
      >
        <UButton
          icon="i-lucide-chevron-up"
          variant="ghost"
          color="neutral"
          size="xs"
          :aria-label="`Move ${field.label} up`"
          :disabled="busy || index === 0"
          @click="emit('move', field, -1)"
        />
        <UButton
          icon="i-lucide-chevron-down"
          variant="ghost"
          color="neutral"
          size="xs"
          :aria-label="`Move ${field.label} down`"
          :disabled="busy || index === fields.length - 1"
          @click="emit('move', field, 1)"
        />
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <UIcon
            v-if="field.icon"
            :name="field.icon"
            class="size-4 shrink-0 text-(--ui-text-muted)"
          />
          <span class="font-medium truncate">{{ field.label }}</span>
          <span
            v-if="field.required"
            class="text-(--ui-error)"
            title="Required"
          >*</span>
          <UBadge
            variant="subtle"
            color="neutral"
            size="sm"
          >
            {{ recordsKindLabel(field.kind) }}
          </UBadge>
          <UBadge
            v-if="field.custom"
            variant="subtle"
            color="primary"
            size="sm"
          >
            Custom
          </UBadge>
          <UBadge
            v-if="field.orphan"
            variant="subtle"
            color="warning"
            size="sm"
            title="No code definition backs this row"
          >
            Stale
          </UBadge>
        </div>
        <div class="flex items-center gap-2 text-xs text-(--ui-text-muted) font-mono truncate">
          <span>{{ field.key }}</span>
          <span v-if="sectionLabel(field)">· {{ sectionLabel(field) }}</span>
        </div>
      </div>

      <div
        class="shrink-0 flex items-center gap-2"
        @click.stop
      >
        <USwitch
          :model-value="!field.hidden"
          :disabled="busy || field.column === 'status'"
          :title="field.column === 'status' ? 'The status field is always shown' : undefined"
          :aria-label="`Toggle visibility of ${field.label}`"
          @update:model-value="emit('toggleHidden', field, !$event)"
        />
      </div>
    </li>
    <li
      v-if="fields.length === 0"
      class="px-3 py-6 text-sm text-(--ui-text-muted) text-center"
    >
      No fields yet.
    </li>
  </ul>
</template>
