<script setup lang="ts">
// Create-record modal: name plus every other required field that has an
// inline editor kind (text/textarea/number/key_select). Required fields of
// other kinds are added after creation on the detail page. On success it
// navigates straight to the new record's detail.
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  typeKey: string
  labelSingular?: string
  fields: RecordsFieldSetting[]
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  created: [id: string]
}>()

const typePath = useRecordsTypePath()

const FORM_KINDS = new Set(['text', 'textarea', 'number', 'key_select'])

const extraFields = computed(() =>
  props.fields.filter(f =>
    f.required && !f.hidden && !f.orphan && f.key !== 'name' && FORM_KINDS.has(f.kind)
  )
)

const name = ref('')
const draft = ref<Record<string, unknown>>({})
const creating = ref(false)
const createError = ref<string | null>(null)

watch(open, (v) => {
  if (v) {
    name.value = ''
    draft.value = {}
    createError.value = null
  }
})

function setDraft(key: string, value: unknown) {
  draft.value = { ...draft.value, [key]: value }
}

function textValue(key: string): string {
  const v = draft.value[key]
  return typeof v === 'string' ? v : ''
}

function numberValue(key: string): number | null {
  const v = draft.value[key]
  return typeof v === 'number' ? v : null
}

function selectValue(key: string): string | undefined {
  const v = draft.value[key]
  return typeof v === 'string' ? v : undefined
}

function optionItems(field: RecordsFieldSetting) {
  return Object.entries(field.options ?? {})
    .filter(([, opt]) => !opt.deleted)
    .map(([key, opt]) => ({ label: opt.label, value: key }))
}

const canSubmit = computed(() =>
  name.value.trim().length > 0
  && extraFields.value.every((f) => {
    const v = draft.value[f.key]
    return v !== undefined && v !== null && v !== ''
  })
)

async function submit() {
  if (!canSubmit.value || creating.value) return
  creating.value = true
  createError.value = null
  try {
    const record = await $fetch<{ id: string }>(`/api/records/entries/${props.typeKey}`, {
      method: 'POST',
      body: { fields: { ...draft.value, name: name.value.trim() } }
    })
    open.value = false
    emit('created', record.id)
    await navigateTo(typePath(props.typeKey, record.id))
  } catch (err) {
    createError.value = recordsErrorMessage(err, 'Failed to create record')
  } finally {
    creating.value = false
  }
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
          New {{ labelSingular?.toLowerCase() ?? 'record' }}
        </h2>

        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="name"
            autofocus
            class="w-full"
            :disabled="creating"
          />
        </UFormField>

        <UFormField
          v-for="field in extraFields"
          :key="field.key"
          :label="field.label"
          required
        >
          <UInput
            v-if="field.kind === 'text'"
            :model-value="textValue(field.key)"
            class="w-full"
            :disabled="creating"
            @update:model-value="setDraft(field.key, $event)"
          />
          <UTextarea
            v-else-if="field.kind === 'textarea'"
            :model-value="textValue(field.key)"
            class="w-full"
            :rows="3"
            :disabled="creating"
            @update:model-value="setDraft(field.key, $event)"
          />
          <UInputNumber
            v-else-if="field.kind === 'number'"
            :model-value="numberValue(field.key)"
            class="w-full"
            :disabled="creating"
            @update:model-value="setDraft(field.key, $event)"
          />
          <USelectMenu
            v-else-if="field.kind === 'key_select'"
            :model-value="selectValue(field.key)"
            :items="optionItems(field)"
            value-key="value"
            label-key="label"
            placeholder="Select..."
            class="w-full"
            :disabled="creating"
            @update:model-value="setDraft(field.key, $event)"
          />
        </UFormField>

        <UAlert
          v-if="createError"
          color="error"
          :title="createError"
        />

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="creating"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :loading="creating"
            :disabled="!canSubmit"
          >
            Create
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
