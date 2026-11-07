<script setup lang="ts">
// Picks the field a field-grouped kanban groups by — the board's columns are
// that field's options (or the users present, for a user field). Also the way
// back from a board whose grouping field was deleted from the record type.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsTabView } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  fields: RecordsFieldSetting[]
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  save: [groupField: string]
}>()

const choices = computed(() =>
  viewsGroupableFields(props.fields).map(f => ({ label: f.label, value: f.key })))

const selected = ref<string | undefined>(undefined)

watch(open, (v) => {
  if (!v) return
  const current = props.view.definition.groupField
  selected.value = choices.value.some(c => c.value === current) ? current : undefined
})

const changed = computed(() =>
  !!selected.value && selected.value !== props.view.definition.groupField)

function submit() {
  if (!changed.value) return
  emit('save', selected.value!)
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <form
        class="p-6 space-y-4"
        @submit.prevent="submit"
      >
        <h2 class="text-lg font-semibold">
          Group cards by
        </h2>

        <UFormField
          label="Field"
          required
        >
          <USelectMenu
            v-model="selected"
            :items="choices"
            value-key="value"
            label-key="label"
            placeholder="Select a field…"
            class="w-full"
          />
          <template
            v-if="choices.length === 0"
            #help
          >
            This record type has no field a board can group by — add a select
            or user field to it first.
          </template>
        </UFormField>

        <p class="text-xs text-(--ui-text-muted)">
          Columns become this field's options. Cards keep whatever value they
          already have, and manually dragged order is remembered per column,
          so cards landing in a new column start in the board's default order.
        </p>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :disabled="!changed"
          >
            Save
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
