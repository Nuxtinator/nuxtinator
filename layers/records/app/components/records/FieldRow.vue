<script setup lang="ts">
// One label/value row on the record detail page, laid out as `layout` says:
// label beside the value ('row'), the same with a narrower label for a
// sidebar ('compact'), or label above a full-width value ('stacked', which
// also gives long text a taller editor). Kinds with an inline
// editor render it when the caller can edit the record; otherwise — and for
// kinds without an editor — the row shows the formatted read-only value
// from the field-kind dispatcher.
import type { Component } from 'vue'
import type { RecordsAttachmentValue } from '#records'
import type { RecordsFieldSetting } from '../../utils/field-kinds'
import TextField from './fields/TextField.vue'
import TextareaField from './fields/TextareaField.vue'
import RichTextField from './fields/RichTextField.vue'
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
import AttachmentsField from './fields/AttachmentsField.vue'
import RefField from './fields/RefField.vue'

const props = withDefaults(defineProps<{
  field: RecordsFieldSetting
  value: unknown
  /** The record detail's canEdit capability — false renders read-only. */
  editable: boolean
  /** Attachments fields: where the editor uploads files. */
  uploadUrl?: string
  /** Rich text fields: the record's files, for the images in the text. */
  images?: RecordsAttachmentValue[]
  /** Rich text fields: where a new image uploads. */
  imageUploadUrl?: string
  /** Tags fields: where the editor gets its suggestions. */
  suggestUrl?: string
  layout?: 'row' | 'compact' | 'stacked'
}>(), {
  uploadUrl: undefined,
  images: undefined,
  imageUploadUrl: undefined,
  suggestUrl: undefined,
  layout: 'row'
})

const LAYOUTS = {
  row: { root: 'sm:grid-cols-[11rem_1fr] gap-1 sm:gap-4 px-4 py-3', top: 'sm:pt-1.5' },
  compact: { root: 'sm:grid-cols-[8rem_1fr] gap-1 sm:gap-3 px-4 py-3', top: 'sm:pt-1.5' },
  stacked: { root: 'gap-1.5', top: '' }
} as const
const classes = computed(() => LAYOUTS[props.layout])

const emit = defineEmits<{
  /** `discardImages` (rich text): files uploaded in the editor that the text doesn't show. */
  commit: [value: unknown, discardImages?: string[]]
  /** Attachments fields: files were uploaded; the record should be refetched. */
  uploaded: []
}>()

// Maps the dispatcher's component names onto the imported editors —
// dynamic `:is` with a string can't resolve auto-registered components.
const EDITORS: Record<string, Component> = {
  RecordsFieldsTextField: TextField,
  RecordsFieldsTextareaField: TextareaField,
  RecordsFieldsRichTextField: RichTextField,
  RecordsFieldsNumberField: NumberField,
  RecordsFieldsKeySelectField: KeySelectField,
  RecordsFieldsBooleanField: BooleanField,
  RecordsFieldsDateField: DateField,
  RecordsFieldsDatetimeField: DatetimeField,
  RecordsFieldsMultiSelectField: MultiSelectField,
  RecordsFieldsTagsField: TagsField,
  RecordsFieldsUserSelectField: UserSelectField,
  RecordsFieldsConnectionField: ConnectionField,
  RecordsFieldsLinkField: LinkField,
  RecordsFieldsAttachmentsField: AttachmentsField,
  RecordsFieldsRefField: RefField
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

const editorProps = computed(() => {
  if (props.field.kind === 'attachments') return { uploadUrl: props.uploadUrl }
  if (props.field.kind === 'tags') return { suggestUrl: props.suggestUrl }
  if (props.field.kind === 'rich_text') return { images: props.images, imageUploadUrl: props.imageUploadUrl }
  if (props.field.kind === 'textarea' && props.layout === 'stacked') return { rows: 6 }
  return {}
})
</script>

<template>
  <div
    class="grid grid-cols-1"
    :class="classes.root"
  >
    <div
      class="text-sm text-(--ui-text-muted)"
      :class="classes.top"
    >
      <UIcon
        :name="recordsFieldIcon(field)"
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
        v-bind="editorProps"
        @commit="(value: unknown, discardImages?: string[]) => emit('commit', value, discardImages)"
        @uploaded="emit('uploaded')"
      />
      <RecordsAttachmentsList
        v-else-if="field.kind === 'attachments'"
        :value="value"
      />
      <RichTextField
        v-else-if="field.kind === 'rich_text' && value"
        :field="field"
        :model-value="value"
        :images="images"
        readonly
      />
      <RefField
        v-else-if="field.kind === 'ref'"
        :field="field"
        :model-value="value"
        readonly
      />
      <p
        v-else
        class="text-sm whitespace-pre-wrap break-words"
        :class="classes.top"
      >
        {{ formatted }}
      </p>
    </div>
  </div>
</template>
