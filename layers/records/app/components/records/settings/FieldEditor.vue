<script setup lang="ts">
// Field create/edit slideover. Create mode picks a kind from the admin
// whitelist (locked forever after create) and derives the key from the
// label until touched. Edit mode sends a minimal patch — only what actually
// changed — so untouched values never turn into stored overrides; the
// server additionally drops override values equal to the code defaults.
// The footer action deletes custom/stale fields outright, or resets a
// manifest field's overrides back to code defaults. Kinds with extra
// definition inputs (the channel kind's channel type) render the settings
// component a layer registered for them; kinds that need such inputs are
// offered only when that layer is loaded.
import { getRecordsFieldKindSettings } from '#records'
import type { RecordsFieldOption } from '#records'
import type { RecordsFieldSetting, RecordsTypeSections } from '../../../utils/field-kinds'
import type { RecordsUpdateFieldPatch } from '../../../composables/useRecordsSchemaAdmin'

const props = defineProps<{
  typeKey: string
  sections: RecordsTypeSections
  /** Custom types take free-form section names; code types only declared ones. */
  typeIsCustom: boolean
  /** The field being edited; null = create mode. */
  field?: RecordsFieldSetting | null
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  saved: []
}>()

const isEdit = computed(() => !!props.field)

const admin = useRecordsSchemaAdmin()

const label = ref('')
const fieldKey = ref('')
const kind = ref('text')
const icon = ref<string | null>(null)
const section = ref('')
const required = ref(false)
const kindExtras = ref<Record<string, unknown>>({})
const optionsDraft = ref<Record<string, RecordsFieldOption>>({})
const keyTouched = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const confirmingDelete = ref(false)

watch(open, async (v) => {
  if (!v) return
  error.value = null
  saving.value = false
  confirmingDelete.value = false
  keyTouched.value = false
  if (props.field) {
    label.value = props.field.label
    fieldKey.value = props.field.key
    kind.value = props.field.kind
    icon.value = props.field.icon
    section.value = props.field.section ?? ''
    required.value = props.field.required
    kindExtras.value = {
      ...(props.field.channelType ? { channelType: props.field.channelType } : {}),
      ...(props.field.target ? { target: props.field.target } : {})
    }
    optionsDraft.value = JSON.parse(JSON.stringify(props.field.options ?? {}))
  } else {
    label.value = ''
    fieldKey.value = ''
    kind.value = 'text'
    icon.value = null
    section.value = ''
    required.value = false
    kindExtras.value = {}
    optionsDraft.value = {}
  }
})

watch(kind, () => {
  if (!isEdit.value) kindExtras.value = {}
})

watch(label, (v) => {
  if (!isEdit.value && !keyTouched.value) fieldKey.value = recordsSlugify(v)
})

const isOptionKind = computed(() => RECORDS_OPTION_KINDS.has(kind.value))
const kindSettings = computed(() => getRecordsFieldKindSettings(kind.value))
const keyValid = computed(() => RECORDS_SLUG_CLIENT_RE.test(fieldKey.value))

// Kinds needing a settings component appear only when one is registered.
const KINDS_NEEDING_SETTINGS = new Set(['communication_channel', 'connection'])
const kindOptions = computed(() =>
  RECORDS_ADMIN_KIND_OPTIONS.filter(k =>
    !KINDS_NEEDING_SETTINGS.has(k.value) || !!getRecordsFieldKindSettings(k.value)))

// The intrinsic name field of a custom type is synthesized in code (see the
// server's RECORDS_INTRINSIC_NAME_FIELD): not custom, not orphan, and — unlike a
// manifest field, whose override row a reset restores to visible defaults —
// nothing an admin should delete or reset away.
const isIntrinsicName = computed(() =>
  props.typeIsCustom
  && props.field?.key === 'name'
  && !props.field.custom
  && !props.field.orphan
)

// A manifest field's section can only be reassigned among declared sections
// (null would mean "revert to code default", not "no section"), so the
// "No section" choice is reserved for custom/stale fields.
//
// reka-ui reserves '' as its clear-selection sentinel and throws on any item
// whose value is an empty string, so "no section" travels through the select
// as NO_SECTION and maps back to the internal '' at the model boundary.
const NO_SECTION = '__none__'
const sectionModel = computed({
  get: () => section.value === '' ? NO_SECTION : section.value,
  set: (v: string) => { section.value = v === NO_SECTION ? '' : v }
})
const sectionItems = computed(() => {
  const declared = Object.entries(props.sections)
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0) || a[0].localeCompare(b[0]))
    .map(([key, s]) => ({ label: s.label, value: key }))
  if (props.field && !props.field.custom && !props.field.orphan) return declared
  return [{ label: 'No section', value: NO_SECTION }, ...declared]
})

const canSubmit = computed(() =>
  label.value.trim().length > 0
  && (isEdit.value || keyValid.value)
  && (isEdit.value || kindSettings.value?.isComplete?.(kindExtras.value) !== false)
)

async function submit() {
  if (!canSubmit.value || saving.value) return
  saving.value = true
  error.value = null
  try {
    if (!props.field) {
      await admin.createField(props.typeKey, {
        fieldKey: fieldKey.value,
        kind: kind.value,
        label: label.value.trim(),
        icon: icon.value ?? undefined,
        section: section.value === '' ? undefined : section.value,
        required: required.value,
        options: isOptionKind.value && Object.keys(optionsDraft.value).length > 0
          ? optionsDraft.value
          : undefined,
        ...(kindSettings.value ? kindExtras.value : {})
      })
    } else {
      const patch: RecordsUpdateFieldPatch = {}
      if (label.value.trim() !== props.field.label) patch.label = label.value.trim()
      if (icon.value !== props.field.icon) patch.icon = icon.value
      if (required.value !== props.field.required) patch.required = required.value
      const currentSection = props.field.section ?? ''
      if (section.value !== currentSection) {
        patch.section = section.value === '' ? null : section.value
      }
      if (
        isOptionKind.value
        && JSON.stringify(optionsDraft.value) !== JSON.stringify(props.field.options ?? {})
      ) {
        patch.options = optionsDraft.value
      }
      if (Object.keys(patch).length > 0) {
        await admin.updateField(props.typeKey, props.field.key, patch)
      }
    }
    open.value = false
    emit('saved')
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to save field')
  } finally {
    saving.value = false
  }
}

// Deletes a custom/stale field's row, or clears a manifest field's override
// row (the server rejects the latter when there is nothing to clear).
async function removeField() {
  if (!props.field || saving.value) return
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  saving.value = true
  error.value = null
  try {
    await admin.deleteField(props.typeKey, props.field.key)
    open.value = false
    emit('saved')
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to delete field')
    confirmingDelete.value = false
  } finally {
    saving.value = false
  }
}

const deleteLabel = computed(() => {
  if (!props.field) return ''
  if (props.field.custom || props.field.orphan) {
    return confirmingDelete.value ? 'Really delete?' : 'Delete field'
  }
  return confirmingDelete.value ? 'Really reset?' : 'Reset to defaults'
})
</script>

<template>
  <USlideover
    v-model:open="open"
    :ui="{ content: 'max-w-md' }"
  >
    <template #content>
      <form
        class="flex flex-col h-full"
        @submit.prevent="submit"
      >
        <header class="flex items-center justify-between gap-2 px-4 py-3 border-b border-(--ui-border)">
          <h2 class="text-lg font-semibold truncate">
            {{ isEdit ? `Edit ${field?.label}` : 'Add field' }}
          </h2>
          <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            aria-label="Close"
            @click="open = false"
          />
        </header>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <UFormField
            label="Label"
            required
          >
            <UInput
              v-model="label"
              class="w-full"
              autofocus
              :disabled="saving"
            />
          </UFormField>

          <UFormField
            v-if="!isEdit"
            label="Key"
            required
            help="Lowercase letters, digits and underscores. Cannot be changed later."
            :error="fieldKey !== '' && !keyValid ? 'Must match [a-z][a-z0-9_]{1,40}' : undefined"
          >
            <UInput
              v-model="fieldKey"
              class="w-full font-mono"
              :disabled="saving"
              @input="keyTouched = true"
            />
          </UFormField>

          <UFormField
            label="Kind"
            :help="isEdit ? undefined : 'Locked after the field is created.'"
          >
            <USelectMenu
              v-if="!isEdit"
              v-model="kind"
              :items="kindOptions"
              value-key="value"
              label-key="label"
              :search-input="false"
              class="w-full"
              :disabled="saving"
            />
            <UBadge
              v-else
              variant="subtle"
              color="neutral"
            >
              {{ recordsKindLabel(kind) }}
            </UBadge>
          </UFormField>

          <component
            :is="kindSettings.component"
            v-if="kindSettings"
            v-model="kindExtras"
            :readonly="isEdit"
            :disabled="saving"
          />

          <UFormField
            label="Icon"
            help="Shown next to the field label. Leave empty for none."
          >
            <IconPicker
              v-model="icon"
              :disabled="saving"
            />
          </UFormField>

          <UFormField
            v-if="typeIsCustom"
            label="Section"
            help="Free-form group name; fields sharing a section render together."
          >
            <UInput
              v-model="section"
              class="w-full"
              :disabled="saving"
            />
          </UFormField>
          <UFormField
            v-else-if="sectionItems.length > 0"
            label="Section"
          >
            <USelectMenu
              v-model="sectionModel"
              :items="sectionItems"
              value-key="value"
              label-key="label"
              :search-input="false"
              class="w-full"
              :disabled="saving"
            />
          </UFormField>

          <UFormField label="Required">
            <USwitch
              v-model="required"
              :disabled="saving"
            />
          </UFormField>

          <UFormField
            v-if="isOptionKind"
          >
            <template #label>
              Options
              <InfoTip
                v-if="field?.column === 'status'"
                text="Mark the statuses that mean a record is closed (archived). Closing a record then asks for a reason when the type has a reason field."
              />
            </template>
            <RecordsSettingsFieldOptionEditor
              v-model="optionsDraft"
              :disabled="saving"
              :closable="field?.column === 'status'"
            />
          </UFormField>

          <UAlert
            v-if="error"
            color="error"
            :title="error"
          />
        </div>

        <footer class="flex items-center gap-2 px-4 py-3 border-t border-(--ui-border)">
          <UButton
            v-if="isEdit && !isIntrinsicName"
            :color="confirmingDelete ? 'error' : 'neutral'"
            variant="ghost"
            :disabled="saving"
            @click="removeField"
          >
            {{ deleteLabel }}
          </UButton>
          <span class="flex-1" />
          <UButton
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :loading="saving"
            :disabled="!canSubmit"
          >
            {{ isEdit ? 'Save' : 'Add field' }}
          </UButton>
        </footer>
      </form>
    </template>
  </USlideover>
</template>
