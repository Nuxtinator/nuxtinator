<script setup lang="ts">
// Options vocabulary editor for select-ish kinds (key_select, multi_select,
// tags). Edits the merged option set as full desired state — the server
// persists only what differs from the code manifest (rename/recolor become
// per-option overrides; brand-new keys become admin-added custom options).
// Removal is soft: `deleted` keeps historical values renderable while the
// option stops being offered. On a status field, options can be marked as
// meaning the record is closed.
import type { CrmFieldOption } from '#crm'
import type { CrmBadgeColor } from '../../../utils/field-kinds'

const options = defineModel<Record<string, CrmFieldOption>>({ required: true })

const props = defineProps<{
  disabled?: boolean
  /** Status field: options can be marked as meaning the record is closed. */
  closable?: boolean
}>()

const COLOR_ITEMS: Array<{ label: string, value: string }> = [
  { label: 'None', value: 'none' },
  { label: 'Primary', value: 'primary' },
  { label: 'Secondary', value: 'secondary' },
  { label: 'Success', value: 'success' },
  { label: 'Info', value: 'info' },
  { label: 'Warning', value: 'warning' },
  { label: 'Error', value: 'error' },
  { label: 'Neutral', value: 'neutral' }
]

const entries = computed(() => Object.entries(options.value))

function patchOption(key: string, patch: Partial<CrmFieldOption>) {
  const current = options.value[key]
  if (!current) return
  options.value = { ...options.value, [key]: { ...current, ...patch } }
}

function setColor(key: string, value: string) {
  const current = options.value[key]
  if (!current) return
  const next: CrmFieldOption = { ...current }
  if (value === 'none') delete next.color
  else next.color = value
  options.value = { ...options.value, [key]: next }
}

// Option keys may start with a digit (unlike type/field slugs), so this is
// looser than crmSlugify: '18–25' → '18_25'.
function optionKeySlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 41)
}

const newLabel = ref('')
const newKey = computed(() => optionKeySlug(newLabel.value))
const canAdd = computed(() =>
  newLabel.value.trim().length > 0
  && newKey.value.length > 0
  && !(newKey.value in options.value)
)

function addOption() {
  if (!canAdd.value || props.disabled) return
  options.value = { ...options.value, [newKey.value]: { label: newLabel.value.trim() } }
  newLabel.value = ''
}

function badgeColor(option: CrmFieldOption): CrmBadgeColor {
  const allowed = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']
  return option.color && allowed.includes(option.color) ? option.color as CrmBadgeColor : 'neutral'
}
</script>

<template>
  <div class="space-y-2">
    <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
      <li
        v-for="[key, option] in entries"
        :key="key"
        class="flex items-center gap-2 px-2 py-1.5"
        :class="option.deleted ? 'opacity-50' : ''"
      >
        <UBadge
          :color="badgeColor(option)"
          variant="subtle"
          size="sm"
          class="shrink-0 font-mono"
        >
          {{ key }}
        </UBadge>
        <UInput
          :model-value="option.label"
          size="sm"
          class="flex-1 min-w-24"
          :disabled="disabled || option.deleted"
          @update:model-value="patchOption(key, { label: String($event) })"
        />
        <USelectMenu
          :model-value="option.color ?? 'none'"
          :items="COLOR_ITEMS"
          value-key="value"
          label-key="label"
          :search-input="false"
          size="sm"
          class="w-28 shrink-0"
          :disabled="disabled || option.deleted"
          @update:model-value="setColor(key, String($event))"
        />
        <UButton
          v-if="closable"
          icon="i-lucide-archive"
          :variant="option.closed ? 'soft' : 'ghost'"
          :color="option.closed ? 'primary' : 'neutral'"
          size="xs"
          :aria-label="`${option.label} counts as closed`"
          :aria-pressed="!!option.closed"
          :title="option.closed ? 'Counts as closed' : 'Mark as closed'"
          :disabled="disabled || option.deleted"
          @click="patchOption(key, { closed: !option.closed })"
        />
        <UButton
          :icon="option.deleted ? 'i-lucide-rotate-ccw' : 'i-lucide-trash-2'"
          variant="ghost"
          color="neutral"
          size="xs"
          :aria-label="option.deleted ? `Restore ${option.label}` : `Remove ${option.label}`"
          :title="option.deleted ? 'Restore option' : 'Remove option (kept for historical values)'"
          :disabled="disabled"
          @click="patchOption(key, { deleted: !option.deleted })"
        />
      </li>
      <li
        v-if="entries.length === 0"
        class="px-3 py-4 text-sm text-(--ui-text-muted) text-center"
      >
        No options yet.
      </li>
    </ul>

    <form
      class="flex items-center gap-2"
      @submit.prevent="addOption"
    >
      <UInput
        v-model="newLabel"
        placeholder="New option label"
        size="sm"
        class="flex-1"
        :disabled="disabled"
      />
      <span
        v-if="newKey"
        class="text-xs text-(--ui-text-muted) font-mono shrink-0"
      >{{ newKey }}</span>
      <UButton
        type="submit"
        icon="i-lucide-plus"
        size="sm"
        variant="soft"
        :disabled="disabled || !canAdd"
      >
        Add
      </UButton>
    </form>
  </div>
</template>
