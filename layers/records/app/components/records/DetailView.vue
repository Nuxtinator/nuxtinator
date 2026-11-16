<script setup lang="ts">
// Record detail in two columns: the main part holds the header (back link,
// click-to-rename name, status badge, share popover, delete button), the
// record's long text (its description), the records under it (a task's
// subtasks, as a list to tick off and add to), the records that mention this
// one, and the merged comment/activity timeline; a sidebar holds every other
// field, in the sections' declared order. On a narrow screen the sidebar sits
// between those first two and the rest. `embedded` is for a dialog: a close button stands
// in for the back link, and deleting reports back instead of leaving the
// page. The
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
  /** Shown inside a dialog rather than as a page. */
  embedded?: boolean
}>()

const emit = defineEmits<{
  /** A write to the record landed. */
  changed: []
  deleted: []
  close: []
}>()

defineSlots<{
  /** Extra header buttons, before Share. */
  actions?: () => unknown
  /** Extra sections at the end of the sidebar. */
  sidebar?: () => unknown
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

// The name field renders in the header, not as a row.
const visibleFields = computed(() =>
  (fieldSettings.value?.fields ?? []).filter(f =>
    !f.hidden && !f.orphan && f.column !== 'name'
    && (f.key !== reasonField.value?.key || recordClosed.value)))

// Long text gets the main column's width; every other field is a sidebar row.
const isLongText = (f: RecordsFieldSetting) => (f.kind === 'textarea' || f.kind === 'rich_text') && !getRecordsFieldWidget(f.kind)
const longTextFields = computed(() => visibleFields.value.filter(isLongText))

// On a type whose records nest, the records under this one are a list in the
// main column instead of a sidebar row. Each child points at its parent
// through the hierarchy's parent field, hidden or not.
const parentKey = computed(() =>
  fieldSettings.value?.fields.find(f => f.hierarchy === 'parent' && f.target === typeKey.value && !f.orphan)?.key ?? null)
const childrenField = computed(() => parentKey.value
  ? visibleFields.value.find(f => f.hierarchy === 'children' && f.target === typeKey.value) ?? null
  : null)

// Images in rich text are files on the record's first attachments field.
const imageField = computed(() => visibleFields.value.find(f => f.kind === 'attachments') ?? null)
const imageFiles = computed(() => imageField.value ? recordsAttachmentList(record.value?.fields[imageField.value.key]) : [])
const imageUploadUrl = computed(() => imageField.value && canEdit.value
  ? `/api/records/entries/${typeKey.value}/${recordId.value}/attachments?field=${imageField.value.key}`
  : undefined)

// Sidebar sections in their declared order, each with its visible fields
// (the endpoint returns fields sorted by order). Fields without a section —
// or referencing an unknown key — collect in a trailing group.
const sectionGroups = computed<SectionGroup[]>(() => {
  const def = fieldSettings.value
  if (!def) return []
  const visible = visibleFields.value.filter(f => !isLongText(f) && f.key !== childrenField.value?.key)
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

// Detail panels other layers inject above the timeline (e.g. inbox's
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
  emit('changed')
}

const closing = ref<{ status: string } | null>(null)
const closingOpen = ref(false)
const closingSaving = ref(false)

// `discardImages`: files a rich text editor uploaded that its text doesn't
// show, removed in the same write.
async function commitField(field: RecordsFieldSetting, value: unknown, discardImages?: string[]) {
  if (field.column === 'status' && reasonField.value && isClosedStatus(value) && !recordClosed.value) {
    closing.value = { status: value as string }
    closingOpen.value = true
    return
  }
  try {
    const patch: Record<string, unknown> = { [field.key]: value }
    if (discardImages?.length && imageField.value) {
      patch[imageField.value.key] = { values: discardImages.map(id => ({ value: id, delete: true })) }
    }
    const saved = await shareConfirm(confirmShare => patchFields(patch, { confirmShare }))
    if (saved) {
      refreshTimeline()
      emit('changed')
    }
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
    emit('changed')
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
    emit('changed')
  } catch (err) {
    toast.add({
      title: 'Rename failed',
      description: recordsErrorMessage(err, 'Failed to rename record'),
      color: 'error'
    })
  }
}

// Hard delete, then back to the type's list (the list refetches on mount, so
// the removed record is gone from it without cache surgery). Inside a dialog
// the caller closes it instead.
const deleting = ref(false)
async function removeRecord() {
  deleting.value = true
  try {
    // Widened to string: the typed-route template for this path unions in
    // GET-only siblings and rejects DELETE.
    const url: string = `/api/records/entries/${typeKey.value}/${recordId.value}`
    await $fetch(url, { method: 'DELETE' })
    if (props.embedded) emit('deleted')
    else await navigateTo(typePath(typeKey.value))
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
  <div class="max-w-6xl mx-auto space-y-6">
    <UAlert
      v-if="error || fieldsError"
      color="error"
      :title="error || fieldsError || 'Something went wrong'"
    />

    <template v-else-if="record">
      <RecordsHeader
        :record="record"
        :status-field="statusField"
        :back-to="embedded ? null : backTo"
        :back-label="backLabel"
        :closable="embedded"
        :can-edit="canEdit && !accountLinked"
        :can-share="canShare"
        :can-delete="canDelete"
        :deleting="deleting"
        @rename="rename"
        @share-changed="refreshTimeline"
        @delete="removeRecord"
        @close="emit('close')"
      >
        <template #actions>
          <slot name="actions" />
        </template>
      </RecordsHeader>

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

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <!-- One column on large screens; on narrow ones its two parts become
             grid items so the sidebar can sit between them. -->
        <div class="contents lg:block lg:min-w-0 lg:space-y-6">
          <div
            v-if="longTextFields.length > 0 || childrenField"
            class="order-1 min-w-0 space-y-6"
          >
            <RecordsFieldRow
              v-for="field in longTextFields"
              :key="field.key"
              layout="stacked"
              :field="field"
              :value="fieldValue(field)"
              :editable="canEdit"
              :images="imageFiles"
              :image-upload-url="imageUploadUrl"
              @commit="(value: unknown, discardImages?: string[]) => commitField(field, value, discardImages)"
              @uploaded="onWidgetChanged"
            />
            <RecordsChildrenList
              v-if="childrenField && parentKey"
              :type-key="typeKey"
              :record-id="recordId"
              :field="childrenField"
              :parent-key="parentKey"
              :status-field="statusField"
              :needs-reason="!!reasonField"
              :can-add="canEdit && (typeInfo?.canCreate ?? false)"
              @changed="onWidgetChanged"
            />
          </div>

          <div class="order-3 min-w-0 space-y-6">
            <RecordsMentionedIn
              :type-key="typeKey"
              :record-id="recordId"
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

            <p class="text-xs text-(--ui-text-muted)">
              Created {{ new Date(record.createdAt).toLocaleString() }}
              · Updated {{ new Date(record.updatedAt).toLocaleString() }}
            </p>
          </div>
        </div>

        <aside class="order-2 min-w-0 space-y-6">
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
                class="grid grid-cols-1 gap-1.5 px-4 py-3"
              >
                <div class="text-sm text-(--ui-text-muted)">
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
                layout="compact"
                :field="field"
                :value="fieldValue(field)"
                :editable="canEdit"
                :upload-url="field.kind === 'attachments' ? `/api/records/entries/${typeKey}/${recordId}/attachments?field=${field.key}` : undefined"
                @commit="commitField(field, $event)"
                @uploaded="onWidgetChanged"
              />
            </template>
          </RecordsFieldSection>

          <slot name="sidebar" />
        </aside>
      </div>

      <RecordsCloseRecordModal
        v-if="reasonField"
        v-model:open="closingOpen"
        :record-name="record.name"
        :reason-field="reasonField"
        :saving="closingSaving"
        @confirm="closeRecord"
      />
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
