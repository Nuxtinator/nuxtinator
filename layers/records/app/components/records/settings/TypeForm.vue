<script setup lang="ts">
// Record-type form, used in two places: the create-type modal (key is
// derived from the label until touched, then locked forever after create)
// and the type editor's "About" card (key shown read-only; label changes
// on code types persist as overrides server-side).
import type { RecordsTypeAccess } from '../../../composables/useRecordsPermissionsAdmin'

const props = defineProps<{
  mode: 'create' | 'edit'
  busy?: boolean
  initial?: {
    typeKey: string
    label: string
    labelSingular: string
    icon: string | null
  }
}>()

const emit = defineEmits<{
  submit: [payload: { typeKey: string, label: string, labelSingular: string, icon: string | null, access?: RecordsTypeAccess }]
  cancel: []
}>()

const label = ref(props.initial?.label ?? '')
const labelSingular = ref(props.initial?.labelSingular ?? '')
const icon = ref<string | null>(props.initial?.icon ?? null)
const typeKey = ref(props.initial?.typeKey ?? '')
const access = ref<RecordsTypeAccess>('everyone')

const accessItems = computed(() => {
  const plural = (label.value.trim() || 'records').toLowerCase()
  return [
    { value: 'everyone', label: 'Everyone', description: `Every member sees and updates all ${plural}.` },
    { value: 'involved', label: 'People involved', description: `Members see the ${plural} they created, are assigned to, or that are shared with them.` },
    { value: 'admins', label: 'Admins only', description: `Only admins see ${plural}.` }
  ]
})

// The key follows the label while the admin hasn't typed a key themselves.
const keyTouched = ref(props.mode === 'edit')
watch(label, (v) => {
  if (props.mode === 'create' && !keyTouched.value) typeKey.value = recordsSlugify(v)
})

const keyReserved = computed(() => RECORDS_RESERVED_TYPE_KEYS.includes(typeKey.value))
const keyValid = computed(() => RECORDS_SLUG_CLIENT_RE.test(typeKey.value) && !keyReserved.value)
const canSubmit = computed(() =>
  label.value.trim().length > 0
  && labelSingular.value.trim().length > 0
  && (props.mode === 'edit' || keyValid.value)
)

function submit() {
  if (!canSubmit.value || props.busy) return
  emit('submit', {
    typeKey: typeKey.value,
    label: label.value.trim(),
    labelSingular: labelSingular.value.trim(),
    icon: icon.value,
    ...(props.mode === 'create' ? { access: access.value } : {})
  })
}
</script>

<template>
  <form
    class="space-y-4"
    @submit.prevent="submit"
  >
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <UFormField
        label="Label (plural)"
        required
      >
        <UInput
          v-model="label"
          placeholder="Companies"
          class="w-full"
          :autofocus="mode === 'create'"
          :disabled="busy"
        />
      </UFormField>
      <UFormField
        label="Label (singular)"
        required
      >
        <UInput
          v-model="labelSingular"
          placeholder="Company"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
    </div>

    <UFormField
      label="Key"
      :required="mode === 'create'"
      :help="mode === 'create' ? 'Lowercase letters, digits and underscores. Cannot be changed later.' : 'Keys are permanent — rename via the labels above.'"
      :error="mode === 'create' && typeKey !== '' && !keyValid ? (keyReserved ? 'This key is reserved' : 'Must match [a-z][a-z0-9_]{1,40}') : undefined"
    >
      <UInput
        v-model="typeKey"
        class="w-full font-mono"
        :disabled="busy || mode === 'edit'"
        @input="keyTouched = true"
      />
    </UFormField>

    <UFormField
      label="Icon"
      help="Shown in the sidebar and type catalog. Leave empty for the default."
    >
      <IconPicker
        v-model="icon"
        :disabled="busy"
      />
    </UFormField>

    <UFormField
      v-if="mode === 'create'"
      label="Who can see and update them?"
      help="Fine-tune per role later in the type's permissions."
    >
      <URadioGroup
        v-model="access"
        :items="accessItems"
        variant="card"
        :disabled="busy"
      />
    </UFormField>

    <div class="flex gap-2 justify-end">
      <UButton
        v-if="mode === 'create'"
        variant="ghost"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Cancel
      </UButton>
      <UButton
        type="submit"
        :loading="busy"
        :disabled="!canSubmit"
      >
        {{ mode === 'create' ? 'Create type' : 'Save' }}
      </UButton>
    </div>
  </form>
</template>
