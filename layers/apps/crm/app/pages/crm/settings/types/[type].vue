<script setup lang="ts">
// Type editor — presentation (labels, icon, visibility), the ordered field
// list with the field builder, and deletion for custom/stale types. All
// writes go through the schema-admin routes, which persist only actual
// overrides for code-declared schema; the page just re-reads the merged
// definitions after each change.
import type { CrmFieldSetting } from '../../../../utils/field-kinds'
import type { CrmTypeFields } from '../../../../composables/useCrmTypes'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))

const { types, ensureTypes, getFields } = useCrmTypes()
const admin = useCrmSchemaAdmin()
const crmPath = useCrmPath()

const sidebarOpen = ref(false)
const { shown: sidebarShown } = useCrmSidebar()
const ready = ref(false)
const pageError = ref<string | null>(null)
const fieldSettings = ref<CrmTypeFields | null>(null)

async function loadFields() {
  try {
    fieldSettings.value = await getFields(typeKey.value)
  } catch (err) {
    pageError.value = crmErrorMessage(err, 'Failed to load fields')
  }
}

onMounted(async () => {
  await Promise.all([
    ensureTypes().catch((err) => {
      pageError.value = crmErrorMessage(err, 'Failed to load record types')
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
    metaError.value = crmErrorMessage(err, 'Failed to save record type')
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
    pageError.value = crmErrorMessage(err, 'Failed to update record type')
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
    await navigateTo(crmPath('/settings'))
  } catch (err) {
    pageError.value = crmErrorMessage(err, 'Failed to delete record type')
    confirmingDelete.value = false
  } finally {
    deleting.value = false
  }
}

// --- Fields ------------------------------------------------------------------

const editorOpen = ref(false)
const editingField = ref<CrmFieldSetting | null>(null)

function addField() {
  editingField.value = null
  editorOpen.value = true
}

function editField(field: CrmFieldSetting) {
  editingField.value = field
  editorOpen.value = true
}

async function toggleFieldHidden(field: CrmFieldSetting, hidden: boolean) {
  busy.value = true
  pageError.value = null
  try {
    await admin.updateField(typeKey.value, field.key, { hidden })
    await reload()
  } catch (err) {
    pageError.value = crmErrorMessage(err, 'Failed to update field')
  } finally {
    busy.value = false
  }
}

async function moveField(field: CrmFieldSetting, dir: -1 | 1) {
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
    pageError.value = crmErrorMessage(err, 'Failed to reorder fields')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <CrmSidebar v-model:open="sidebarOpen" />

    <section
      class="flex-1 flex flex-col min-w-0 border-l-0 border-(--ui-border) overflow-hidden"
      :class="{ 'lg:border-l': sidebarShown }"
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          v-if="sidebarShown"
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open record types"
          @click="sidebarOpen = true"
        />
        <UButton
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Back to CRM settings"
          :to="crmPath('/settings')"
        />
        <h1 class="flex-1 text-lg font-semibold truncate flex items-center gap-2">
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

      <div class="flex-1 overflow-y-auto p-4 space-y-8">
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
          description="You need the 'Manage CRM schema' permission to change record types and fields."
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
            <CrmSettingsTypeForm
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

            <CrmSettingsFieldList
              :fields="fieldSettings?.fields ?? []"
              :sections="fieldSettings?.sections ?? {}"
              :busy="busy"
              @edit="editField"
              @move="moveField"
              @toggle-hidden="toggleFieldHidden"
            />
          </section>
        </template>
      </div>
    </section>

    <CrmSettingsFieldEditor
      v-model:open="editorOpen"
      :type-key="typeKey"
      :sections="fieldSettings?.sections ?? {}"
      :type-is-custom="typeIsCustom"
      :field="editingField"
      @saved="reload"
    />
  </div>
</template>
