<script setup lang="ts">
// Record detail: header (back link, click-to-rename name, status badge,
// share popover, delete button), the field sections in declared order, the
// connections panel, and the merged comment/activity timeline. The
// server-evaluated capabilities on the detail response gate every write
// affordance: without canEdit, editors render as formatted read-only values,
// field widgets lose their mutation controls and renaming is off; anyone
// who can open the record can comment. The delete button needs canDelete. With canEdit,
// editable kinds commit inline through the optimistic patchFields. Kinds with
// a registered field widget (the crm layer's channel widget) render through
// it instead; widgets change the record through their own routes and ask for
// a refetch. Any action that writes activity rows refreshes the timeline so it
// stays in step without a full reload. Setting a closed status asks for the
// reason first (RecordsCloseRecordModal).
import { getRecordsDetailPanels, getRecordsFieldWidget } from '#records'
import type { RecordsTypeFields } from '../../composables/useRecordsTypes'
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  typeKey: string
  recordId: string
}>()

const typeKey = computed(() => props.typeKey)
const recordId = computed(() => props.recordId)
const orgKey = useRecordsOrgKey()

const { types, ensureTypes, getFields } = useRecordsTypes()
const typePath = useRecordsTypePath()
const toast = useToast()

const typeInfo = computed(() => types.value.find(t => t.key === typeKey.value) ?? null)

// Keyed on the org as well as the type: switching orgs keeps this page
// instance alive (same route record, new orgSlug param), and the caches are
// per-org, so the fetches must re-run.
const fieldSettings = ref<RecordsTypeFields | null>(null)
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
    if (current()) fieldsError.value = recordsErrorMessage(err, 'Failed to load record type')
  }
}, { immediate: true })

const { record, pending, error, refresh, patchFields } = useRecordsRecord(typeKey, recordId)
const shareConfirm = useRecordsShareConfirm()

// The back link goes wherever the user came from (a meeting the task was
// opened from, a contact's timeline, ...) — the router stashes the SPA
// referrer in history.state.back. A record opened directly (fresh tab or
// deep link) has none, so it falls back to its type's list, which the label
// also reflects. SSR is off, so history is always readable.
const referrer = computed(() => window.history.state?.back as string | null)
const backTo = computed(() => referrer.value ?? typePath(typeKey.value))
const backLabel = computed(() => referrer.value ? 'Back' : typeInfo.value?.label ?? 'Back')

// Server-evaluated capability flags for this record (see RecordCapabilities).
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

// Closing: a status option flagged `closed` archives the record. When the
// type has a reason field, closing asks for the reason first, and the reason
// row only shows while the record is closed.
const reasonField = computed(() => {
  const key = fieldSettings.value?.closedReasonField
  return key ? fieldSettings.value?.fields.find(f => f.key === key) ?? null : null
})
function isClosedStatus(value: unknown): boolean {
  return typeof value === 'string' && !!statusField.value?.options?.[value]?.closed
}
const recordClosed = computed(() => isClosedStatus(record.value?.status))

interface SectionGroup {
  key: string
  label: string
  fields: RecordsFieldSetting[]
}

// Sections in their declared order, each with its visible fields (the
// endpoint returns fields sorted by order). The name field renders in the
// header, not as a row. Fields without a section — or referencing an
// unknown key — collect in a trailing group.
const sectionGroups = computed<SectionGroup[]>(() => {
  const def = fieldSettings.value
  if (!def) return []
  const visible = def.fields.filter(f =>
    !f.hidden && !f.orphan && f.column !== 'name'
    && (f.key !== reasonField.value?.key || recordClosed.value))
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
const detailPanels = computed(() => getRecordsDetailPanels(typeKey.value))

function fieldValue(field: RecordsFieldSetting): unknown {
  return record.value?.fields[field.key] ?? null
}

// Field widgets change the record through their own routes; the record
// refetch picks up the new values and the timeline the new activity rows.
function onWidgetChanged() {
  refresh()
  refreshTimeline()
}

const closing = ref<{ status: string } | null>(null)
const closingOpen = ref(false)
const closingSaving = ref(false)

async function commitField(field: RecordsFieldSetting, value: unknown) {
  if (field.column === 'status' && reasonField.value && isClosedStatus(value) && !recordClosed.value) {
    closing.value = { status: value as string }
    closingOpen.value = true
    return
  }
  try {
    const saved = await shareConfirm(confirmShare => patchFields({ [field.key]: value }, { confirmShare }))
    if (saved) refreshTimeline()
  } catch (err) {
    toast.add({
      title: 'Update failed',
      description: recordsErrorMessage(err, `Failed to update ${field.label}`),
      color: 'error'
    })
  }
}

async function closeRecord(reason: string) {
  if (!closing.value || !statusField.value || !reasonField.value) return
  closingSaving.value = true
  try {
    await patchFields({ [statusField.value.key]: closing.value.status, [reasonField.value.key]: reason })
    closingOpen.value = false
    refresh()
    refreshTimeline()
  } catch (err) {
    toast.add({
      title: 'Close failed',
      description: recordsErrorMessage(err, 'Failed to close record'),
      color: 'error'
    })
  } finally {
    closingSaving.value = false
  }
}

async function rename(name: string) {
  try {
    await patchFields({ name })
    refreshTimeline()
  } catch (err) {
    toast.add({
      title: 'Rename failed',
      description: recordsErrorMessage(err, 'Failed to rename record'),
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
    const url: string = `/api/records/entries/${typeKey.value}/${recordId.value}`
    await $fetch(url, { method: 'DELETE' })
    await navigateTo(typePath(typeKey.value))
  } catch (err) {
    toast.add({
      title: 'Delete failed',
      description: recordsErrorMessage(err, 'Failed to delete record'),
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
      <RecordsHeader
        :record="record"
        :status-field="statusField"
        :back-to="backTo"
        :back-label="backLabel"
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

      <RecordsFieldSection
        v-for="group in sectionGroups"
        :key="group.key"
        :label="group.label"
      >
        <template
          v-for="field in group.fields"
          :key="field.key"
        >
          <div
            v-if="getRecordsFieldWidget(field.kind)"
            class="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-1 sm:gap-4 px-4 py-3"
          >
            <div class="text-sm text-(--ui-text-muted) sm:pt-1.5">
              {{ field.label }}<span
                v-if="field.required"
                class="text-(--ui-error)"
              > *</span>
            </div>
            <div class="min-w-0">
              <component
                :is="getRecordsFieldWidget(field.kind)!.component"
                :record="record"
                :type-key="typeKey"
                :field="field"
                :value="fieldValue(field)"
                :editable="canEdit"
                @refresh="onWidgetChanged"
              />
            </div>
          </div>
          <RecordsFieldRow
            v-else
            :field="field"
            :value="fieldValue(field)"
            :editable="canEdit"
            :upload-url="field.kind === 'attachments' ? `/api/records/entries/${typeKey}/${recordId}/attachments?field=${field.key}` : undefined"
            @commit="commitField(field, $event)"
            @uploaded="onWidgetChanged"
          />
        </template>
      </RecordsFieldSection>

      <RecordsConnectionsPanel
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

      <RecordsTimeline
        ref="timeline"
        :type-key="typeKey"
        :record-id="recordId"
        :can-comment="true"
      />

      <RecordsCloseRecordModal
        v-if="reasonField"
        v-model:open="closingOpen"
        :record-name="record.name"
        :reason-field="reasonField"
        :saving="closingSaving"
        @confirm="closeRecord"
      />

      <p class="text-xs text-(--ui-text-muted)">
        Created {{ formatDateTime(record.createdAt) }}
        · Updated {{ formatDateTime(record.updatedAt) }}
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
