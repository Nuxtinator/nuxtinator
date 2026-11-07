<script setup lang="ts">
// Type editor — presentation (labels, icon, visibility), the ordered field
// list with the field builder, and deletion for custom/stale types. All
// writes go through the schema-admin routes, which persist only actual
// overrides for code-declared schema; the page just re-reads the merged
// definitions after each change. Rendered by the org settings shell (multi
// mode) and the host admin shell (single mode).
import type { RecordsFieldSetting } from '../../../utils/field-kinds'
import type { RecordsTypeFields } from '../../../composables/useRecordsTypes'

const props = defineProps<{ typeKey: string }>()
const typeKey = computed(() => props.typeKey)

const { types, ensureTypes, getFields } = useRecordsTypes()
const admin = useRecordsSchemaAdmin()
const settingsPath = useRecordsSettingsPath()
const typePath = useRecordsTypePath()

const ready = ref(false)
const pageError = ref<string | null>(null)
const fieldSettings = ref<RecordsTypeFields | null>(null)

async function loadFields() {
  try {
    fieldSettings.value = await getFields(typeKey.value)
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to load fields')
  }
}

onMounted(async () => {
  await Promise.all([
    ensureTypes().catch((err) => {
      pageError.value = recordsErrorMessage(err, 'Failed to load record types')
    }),
    admin.ensureAccess()
  ])
  if (admin.canManage.value) await loadFields()
  ready.value = true
})

const canManage = admin.canManage
const typeInfo = computed(() => types.value.find(t => t.key === typeKey.value) ?? null)
// Custom AND stale types take free-form sections; code types only declared ones.
const typeIsCustom = computed(() => !!typeInfo.value && (typeInfo.value.custom || typeInfo.value.orphan))
// Stale rows have no definition to edit — they can only be deleted, so the
// editing surfaces stay hidden for them (the server 404s such writes anyway).
const isOrphan = computed(() => !!typeInfo.value?.orphan)

// The component is reused when navigating between type editors.
watch(typeKey, async () => {
  pageError.value = null
  confirmingDelete.value = false
  if (ready.value && canManage.value) await reload()
})

const busy = ref(false)

async function reload() {
  fieldSettings.value = null
  await loadFields()
}

// --- Type meta -------------------------------------------------------------

const metaError = ref<string | null>(null)
const savingMeta = ref(false)

async function onSaveMeta(payload: { typeKey: string, label: string, labelSingular: string, icon: string | null }) {
  savingMeta.value = true
  metaError.value = null
  try {
    await admin.updateType(typeKey.value, {
      label: payload.label,
      labelSingular: payload.labelSingular,
      icon: payload.icon
    })
  } catch (err) {
    metaError.value = recordsErrorMessage(err, 'Failed to save record type')
  } finally {
    savingMeta.value = false
  }
}

async function toggleTypeHidden(hidden: boolean) {
  busy.value = true
  pageError.value = null
  try {
    await admin.updateType(typeKey.value, { hidden })
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to update record type')
  } finally {
    busy.value = false
  }
}

// --- Closing -----------------------------------------------------------------

// Single-choice fields that can hold why a record was closed.
const reasonFieldItems = computed(() =>
  (fieldSettings.value?.fields ?? [])
    .filter(f => f.kind === 'key_select' && !f.column && !f.orphan)
    .map(f => ({ label: f.label, value: f.key }))
)

async function setReasonField(key: string | null) {
  busy.value = true
  pageError.value = null
  try {
    await admin.updateType(typeKey.value, { closedReasonField: key })
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to update the reason field')
  } finally {
    busy.value = false
  }
}

// --- Type deletion (custom/stale only) --------------------------------------

const confirmingDelete = ref(false)
const deleting = ref(false)

async function removeType() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  deleting.value = true
  pageError.value = null
  try {
    await admin.deleteType(typeKey.value)
    await navigateTo(settingsPath())
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to delete record type')
    confirmingDelete.value = false
  } finally {
    deleting.value = false
  }
}

// --- Fields ------------------------------------------------------------------

const editorOpen = ref(false)
const editingField = ref<RecordsFieldSetting | null>(null)

function addField() {
  editingField.value = null
  editorOpen.value = true
}

function editField(field: RecordsFieldSetting) {
  editingField.value = field
  editorOpen.value = true
}

async function toggleFieldHidden(field: RecordsFieldSetting, hidden: boolean) {
  busy.value = true
  pageError.value = null
  try {
    await admin.updateField(typeKey.value, field.key, { hidden })
    await reload()
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to update field')
  } finally {
    busy.value = false
  }
}

async function moveField(field: RecordsFieldSetting, dir: -1 | 1) {
  const list = [...(fieldSettings.value?.fields ?? [])]
  const from = list.findIndex(f => f.key === field.key)
  const to = from + dir
  if (from === -1 || to < 0 || to >= list.length) return
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved!)
  busy.value = true
  pageError.value = null
  try {
    await admin.reorderFields(typeKey.value, list)
    await reload()
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to reorder fields')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="flex items-center gap-2">
      <UButton
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back to records settings"
        :to="settingsPath()"
      />
      <h1 class="flex-1 text-3xl font-bold truncate flex items-center gap-2">
        {{ typeInfo?.label ?? typeKey }}
        <UBadge
          v-if="typeInfo?.custom"
          variant="subtle"
          color="primary"
          size="sm"
        >
          Custom
        </UBadge>
        <UBadge
          v-if="typeInfo?.orphan"
          variant="subtle"
          color="warning"
          size="sm"
        >
          Stale
        </UBadge>
      </h1>
      <template v-if="canManage && typeInfo">
        <UButton
          v-if="!isOrphan && !typeInfo.hidden && typeInfo.canRead"
          icon="i-lucide-table"
          variant="ghost"
          color="neutral"
          size="sm"
          :to="typePath(typeKey)"
        >
          View {{ typeInfo.label.toLowerCase() }}
        </UButton>
        <USwitch
          v-if="!isOrphan"
          :model-value="!typeInfo.hidden"
          :disabled="busy"
          aria-label="Toggle type visibility"
          @update:model-value="toggleTypeHidden(!$event)"
        />
        <UButton
          v-if="typeIsCustom"
          :color="confirmingDelete ? 'error' : 'neutral'"
          variant="ghost"
          size="sm"
          :loading="deleting"
          @click="removeType"
        >
          {{ confirmingDelete ? 'Really delete?' : 'Delete type' }}
        </UButton>
      </template>
    </header>

    <div class="pb-24 space-y-8">
      <div
        v-if="!ready"
        class="grid place-items-center py-24 text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-6 animate-spin"
        />
      </div>

      <UAlert
        v-else-if="!canManage"
        color="warning"
        icon="i-lucide-lock"
        title="Schema management requires permission"
        description="You need the 'Manage record types' permission to change record types and fields."
      />

      <UAlert
        v-else-if="!typeInfo"
        color="error"
        :title="`Unknown record type: ${typeKey}`"
      />

      <template v-else>
        <UAlert
          v-if="pageError"
          color="error"
          :title="pageError"
        />

        <UAlert
          v-if="isOrphan"
          color="warning"
          icon="i-lucide-archive"
          title="Stale record type"
          description="No code manifest backs this row anymore. It can only be deleted (blocked while records of this type still exist)."
        />

        <section
          v-if="!isOrphan"
          class="space-y-3"
        >
          <h2 class="text-base font-semibold">
            About
          </h2>
          <UAlert
            v-if="metaError"
            color="error"
            :title="metaError"
          />
          <RecordsSettingsTypeForm
            :key="typeInfo.key + typeInfo.label + (typeInfo.icon ?? '')"
            mode="edit"
            :busy="savingMeta"
            :initial="{
              typeKey: typeInfo.key,
              label: typeInfo.label,
              labelSingular: typeInfo.labelSingular,
              icon: typeInfo.icon
            }"
            @submit="onSaveMeta"
          />
        </section>

        <section
          v-if="!isOrphan && typeInfo.statusField"
          class="space-y-3"
        >
          <h2 class="text-base font-semibold">
            Closing
            <InfoTip text="Records are closed (archived) by setting a status marked as closed in the status field's options. Pick the field that holds why: closing then asks for a reason, and reopening clears it." />
          </h2>
          <UFormField label="Reason closed field">
            <div class="flex items-center gap-2">
              <USelectMenu
                :model-value="typeInfo.closedReasonField ?? undefined"
                :items="reasonFieldItems"
                value-key="value"
                label-key="label"
                placeholder="No reason field"
                :search-input="false"
                class="w-full sm:w-72"
                :disabled="busy"
                @update:model-value="setReasonField(String($event))"
              />
              <UButton
                v-if="typeInfo.closedReasonField"
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Reset the reason field to the default"
                title="Reset to the default"
                :disabled="busy"
                @click="setReasonField(null)"
              />
            </div>
          </UFormField>
        </section>

        <section
          v-if="!isOrphan"
          class="space-y-3"
        >
          <div class="flex items-center gap-2">
            <div class="flex-1">
              <h2 class="text-base font-semibold">
                Fields
              </h2>
              <p class="text-sm text-(--ui-text-muted)">
                Reorder, relabel, hide, or add custom fields. Code-shipped fields keep their kind and storage.
              </p>
            </div>
            <UButton
              icon="i-lucide-plus"
              size="sm"
              :disabled="busy"
              @click="addField"
            >
              Add field
            </UButton>
          </div>

          <RecordsSettingsFieldList
            :fields="fieldSettings?.fields ?? []"
            :sections="fieldSettings?.sections ?? {}"
            :busy="busy"
            @edit="editField"
            @move="moveField"
            @toggle-hidden="toggleFieldHidden"
          />
        </section>

        <section
          v-if="!isOrphan"
          class="space-y-3"
        >
          <div>
            <h2 class="text-base font-semibold">
              Permissions
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              What each role may do with {{ typeInfo.label.toLowerCase() }}. Cells left on
              Inherit follow the role's permission slugs.
            </p>
          </div>
          <RecordsSettingsRoleGrantsMatrix :type-key="typeKey" />
        </section>
      </template>
    </div>

    <RecordsSettingsFieldEditor
      v-model:open="editorOpen"
      :type-key="typeKey"
      :sections="fieldSettings?.sections ?? {}"
      :type-is-custom="typeIsCustom"
      :field="editingField"
      @saved="reload"
    />
  </div>
</template>
