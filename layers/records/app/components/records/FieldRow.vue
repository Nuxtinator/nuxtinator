<script setup lang="ts">
// One label/value row on the record detail page. Kinds with an inline
// editor render it when the caller can edit the record; otherwise — and for
// kinds without an editor — the row shows the formatted read-only value
// from the field-kind dispatcher.
import type { Component } from 'vue'
import type { RecordsFieldSetting } from '../../utils/field-kinds'
import TextField from './fields/TextField.vue'
import TextareaField from './fields/TextareaField.vue'
import NumberField from './fields/NumberField.vue'
import KeySelectField from './fields/KeySelectField.vue'
import BooleanField from './fields/BooleanField.vue'
import DateField from './fields/DateField.vue'
import DatetimeField from './fields/DatetimeField.vue'
import MultiSelectField from './fields/MultiSelectField.vue'
import TagsField from './fields/TagsField.vue'
import UserSelectField from './fields/UserSelectField.vue'
import ConnectionField from './fields/ConnectionField.vue'
import LinkField from './fields/LinkField.vue'

const props = defineProps<{
  field: RecordsFieldSetting
  value: unknown
  /** The record detail's canEdit capability — false renders read-only. */
  editable: boolean
}>()

const emit = defineEmits<{
  commit: [value: unknown]
}>()

// Maps the dispatcher's component names onto the imported editors —
// dynamic `:is` with a string can't resolve auto-registered components.
const EDITORS: Record<string, Component> = {
  RecordsFieldsTextField: TextField,
  RecordsFieldsTextareaField: TextareaField,
  RecordsFieldsNumberField: NumberField,
  RecordsFieldsKeySelectField: KeySelectField,
  RecordsFieldsBooleanField: BooleanField,
  RecordsFieldsDateField: DateField,
  RecordsFieldsDatetimeField: DatetimeField,
  RecordsFieldsMultiSelectField: MultiSelectField,
  RecordsFieldsTagsField: TagsField,
  RecordsFieldsUserSelectField: UserSelectField,
  RecordsFieldsConnectionField: ConnectionField,
  RecordsFieldsLinkField: LinkField
}

const renderer = computed(() => recordsRendererFor(props.field.kind))
const editor = computed(() => {
  if (!props.editable) return null
  const name = renderer.value.component
  return name ? EDITORS[name] ?? null : null
})
// The user directory resolves user_select ids in read-only rows (the page
// primes it for the timeline; unresolved ids fall back to a count).
const { userName } = useRecordsUsers()
const formatted = computed(() => renderer.value.format(props.value, props.field, { userName }))
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-1 sm:gap-4 px-4 py-3">
    <div class="text-sm text-(--ui-text-muted) sm:pt-1.5">
      <UIcon
        v-if="field.icon"
        :name="field.icon"
        class="size-4 shrink-0 inline-block align-text-bottom mr-1"
      />{{ field.label }}<span
        v-if="field.required"
        class="text-(--ui-error)"
      > *</span>
    </div>
    <div class="min-w-0">
      <component
        :is="editor"
        v-if="editor"
        :field="field"
        :model-value="value"
        @commit="emit('commit', $event)"
      />
      <p
        v-else
        class="text-sm sm:pt-1.5 whitespace-pre-wrap break-words"
      >
        {{ formatted }}
      </p>
    </div>
  </div>
</template>
