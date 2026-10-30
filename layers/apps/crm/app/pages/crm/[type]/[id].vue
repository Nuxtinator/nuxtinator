<script setup lang="ts">
// Record detail: header (back link, click-to-rename name, status badge,
// share popover, delete button), the field sections in declared order, the
// connections panel, and the merged comment/activity timeline. The
// server-evaluated capabilities on the detail response gate every write
// affordance: without canEdit, editors render as formatted read-only values,
// the channel widget and consent panel lose their mutation controls, renaming
// is off, and the comment composer hides; the delete button needs canDelete.
// With canEdit, editable kinds commit inline through
// the optimistic patchFields; communication_channel fields render through
// the channel widget (its mutations go through the channel routes, so it
// asks for a record refetch instead of emitting a patch). Any action that
// writes activity rows (field patch, rename, channel/consent change, share
// change) refreshes the timeline so it stays in step without a full reload.
import type { CrmChannelEntry } from '#crm'
import { getCrmDetailPanels } from '#crm'
import type { CrmTypeFields } from '../../../composables/useCrmTypes'
import type { CrmFieldSetting } from '../../../utils/field-kinds'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))
const recordId = computed(() => String(route.params.id ?? ''))
const orgKey = useCrmOrgKey()

const { types, ensureTypes, getFields } = useCrmTypes()
const crmPath = useCrmPath()
const toast = useToast()

const typeInfo = computed(() => types.value.find(t => t.key === typeKey.value) ?? null)

// Keyed on the org as well as the type: switching orgs keeps this page
// instance alive (same route record, new orgSlug param), and the caches are
// per-org, so the fetches must re-run.
const fieldSettings = ref<CrmTypeFields | null>(null)
const fieldsError = ref<string | null>(null)
watch([typeKey, orgKey], async ([key, org]) => {
  ensureTypes().catch(() => {
    // The fields fetch below reports errors; the back label falls back.
  })
  fieldSettings.value = null
  fieldsError.value = null
  if (!key) return
  const current = () => key === typeKey.value && org === orgKey.value
  try {
    const res = await getFields(key)
    if (current()) fieldSettings.value = res
  } catch (err) {
    if (current()) fieldsError.value = crmErrorMessage(err, 'Failed to load record type')
  }
}, { immediate: true })

const { record, pending, error, refresh, patchFields } = useCrmRecord(typeKey, recordId)

// Server-evaluated capability flags for this record (see CrmRecordCapabilities).
const canEdit = computed(() => record.value?.capabilities.canEdit ?? false)
const canShare = computed(() => record.value?.capabilities.canShare ?? false)
const canDelete = computed(() => record.value?.capabilities.canDelete ?? false)

// A record linked to a user account shows that account's name and email
// addresses; only the person changes them (see server/utils/account-link.ts).
const accountLinked = computed(() => !!record.value?.userId)

// The timeline self-fetches; this handle re-pulls it after actions on this
// page that append activity rows.
const timeline = ref<{ refresh: () => Promise<void> } | null>(null)
function refreshTimeline() {
  timeline.value?.refresh()
}

const statusField = computed(() =>
  fieldSettings.value?.fields.find(f => f.column === 'status') ?? null
)

interface SectionGroup {
  key: string
  label: string
  fields: CrmFieldSetting[]
}

// Sections in their declared order, each with its visible fields (the
// endpoint returns fields sorted by order). The name field renders in the
// header, not as a row. Fields without a section — or referencing an
// unknown key — collect in a trailing group.
const sectionGroups = computed<SectionGroup[]>(() => {
  const def = fieldSettings.value
  if (!def) return []
  const visible = def.fields.filter(f => !f.hidden && !f.orphan && f.column !== 'name')
  const known = new Set(Object.keys(def.sections))
  const groups = Object.entries(def.sections)
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
    .map(([key, section]) => ({
      key,
      label: section.label,
      fields: visible.filter(f => f.section === key)
    }))
  const rest = visible.filter(f => !f.section || !known.has(f.section))
  if (rest.length > 0) groups.push({ key: '_other', label: 'Other', fields: rest })
  return groups.filter(g => g.fields.length > 0)
})

// Detail panels other layers inject after the connections panel (e.g. inbox's
// conversations panel). Each self-gates on its own permission and renders
// nothing when unauthorized, so the page just lists whatever matches the type.
const detailPanels = computed(() => getCrmDetailPanels(typeKey.value))

function fieldValue(field: CrmFieldSetting): unknown {
  return record.value?.fields[field.key] ?? null
}

function channelEntries(field: CrmFieldSetting): CrmChannelEntry[] {
  const value = fieldValue(field)
  return Array.isArray(value) ? value as CrmChannelEntry[] : []
}

// Channel/consent mutations happen inside the widget; the record refetch
// picks up the new entries and the timeline the new activity rows.
function onChannelsChanged() {
  refresh()
  refreshTimeline()
}

async function commitField(field: CrmFieldSetting, value: unknown) {
  try {
    await patchFields({ [field.key]: value })
    refreshTimeline()
  } catch (err) {
    toast.add({
      title: 'Update failed',
      description: crmErrorMessage(err, `Failed to update ${field.label}`),
      color: 'error'
    })
  }
}

async function rename(name: string) {
  try {
    await patchFields({ name })
    refreshTimeline()
  } catch (err) {
    toast.add({
      title: 'Rename failed',
      description: crmErrorMessage(err, 'Failed to rename record'),
      color: 'error'
    })
  }
}

// Hard delete, then back to the type's list (the list refetches on mount, so
// the removed record is gone from it without cache surgery).
const deleting = ref(false)
async function removeRecord() {
  deleting.value = true
  try {
    // Widened to string: the typed-route template for this path unions in
    // GET-only siblings and rejects DELETE.
    const url: string = `/api/crm/records/${typeKey.value}/${recordId.value}`
    await $fetch(url, { method: 'DELETE' })
    await navigateTo(crmPath(`/${typeKey.value}`))
  } catch (err) {
    toast.add({
      title: 'Delete failed',
      description: crmErrorMessage(err, 'Failed to delete record'),
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <UAlert
      v-if="error || fieldsError"
      color="error"
      :title="error || fieldsError || 'Something went wrong'"
    />

    <template v-else-if="record">
      <CrmRecordHeader
        :record="record"
        :status-field="statusField"
        :back-to="crmPath(`/${typeKey}`)"
        :back-label="typeInfo?.label ?? 'Back'"
        :can-edit="canEdit && !accountLinked"
        :can-share="canShare"
        :can-delete="canDelete"
        :deleting="deleting"
        @rename="rename"
        @share-changed="refreshTimeline"
        @delete="removeRecord"
      />

      <p
        v-if="accountLinked"
        class="flex items-center gap-1.5 text-sm text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-user-round-check"
          class="size-4 shrink-0"
        />
        This person has an account. Their name and email address come from it, and only they can change them.
      </p>

      <CrmFieldSection
        v-for="group in sectionGroups"
        :key="group.key"
        :label="group.label"
      >
        <template
          v-for="field in group.fields"
          :key="field.key"
        >
          <div
            v-if="field.kind === 'communication_channel'"
            class="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-1 sm:gap-4 px-4 py-3"
          >
            <div class="text-sm text-(--ui-text-muted) sm:pt-1.5">
              {{ field.label }}<span
                v-if="field.required"
                class="text-(--ui-error)"
              > *</span>
            </div>
            <div class="min-w-0">
              <CrmChannelWidget
                :record-id="record.id"
                :type-key="typeKey"
                :field="field"
                :entries="channelEntries(field)"
                :editable="canEdit"
                :addresses-locked="!!field.channelType && record.accountOwnedChannelTypes.includes(field.channelType)"
                @refresh="onChannelsChanged"
              />
            </div>
          </div>
          <CrmFieldRow
            v-else
            :field="field"
            :value="fieldValue(field)"
            :editable="canEdit"
            @commit="commitField(field, $event)"
          />
        </template>
      </CrmFieldSection>

      <CrmConnectionsPanel
        :fields="fieldSettings?.fields ?? []"
        :record="record"
      />

      <component
        :is="panel.component"
        v-for="panel in detailPanels"
        :key="panel.id"
        :record-id="record.id"
        :record-type="typeKey"
      />

      <CrmTimeline
        ref="timeline"
        :type-key="typeKey"
        :record-id="recordId"
        :can-comment="canEdit"
      />

      <p class="text-xs text-(--ui-text-muted)">
        Created {{ new Date(record.createdAt).toLocaleString() }}
        · Updated {{ new Date(record.updatedAt).toLocaleString() }}
      </p>
    </template>

    <div
      v-else-if="pending"
      class="grid place-items-center py-24 text-(--ui-text-muted)"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-6 animate-spin"
      />
    </div>
  </div>
</template>
