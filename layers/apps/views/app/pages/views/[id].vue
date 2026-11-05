<script setup lang="ts">
// One open view: header (name, visibility, view menu), the renderer for its
// type, and the interaction plumbing — optimistic moves with the poll loop
// suspended while a drag settles, quick-add through the records create
// route, and definition updates for custom-board columns.
import { generateNKeysBetween } from 'fractional-indexing'
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsColumnDef, ViewsConnectionDisplay, ViewsVisibility } from '../../utils/views-types'
import { viewsDragMode } from '../../utils/views-types'
import type { ViewsMovePayload } from '../../composables/useViewsDetail'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const toast = useToast()
const viewsPath = useViewsPath()
const viewId = computed(() => String(route.params.id ?? ''))

const {
  view, records, pending, error,
  q, sort, dir, page, pageSize, personalFilters,
  refresh, refreshRecords, beginDrag, endDrag, move
} = useViewsDetail(viewId)

// --- record type fields (renderers + filter vocabulary) ---------------------

const { types, ensureTypes, getFields } = useRecordsTypes()
const fields = ref<RecordsFieldSetting[]>([])
watch(() => view.value?.recordTypeKey, async (key) => {
  fields.value = []
  if (!key) return
  ensureTypes().catch(() => {
    // canCreate stays false until the catalog loads.
  })
  try {
    const res = await getFields(key)
    if (key === view.value?.recordTypeKey) fields.value = res.fields
  } catch {
    // Renderers degrade to name-only cards; the feed still loads.
  }
}, { immediate: true })

// The people this view shows are resolved by id: the shared directory holds
// one page of the org's members, and a record may reference anyone.
const { ensureUserIds } = useRecordsUsers()
watch([records, fields], ([recs, defs]) => {
  if (!recs || defs.length === 0) return
  const ids = viewsReferencedUserIds(
    recs.items,
    defs,
    view.value?.definition.groupField ?? null
  )
  if (ids.length > 0) {
    ensureUserIds(ids).catch(() => {
      // Unresolved ids render as "Unknown user"; the board still works.
    })
  }
})

const typeInfo = computed(() =>
  types.value.find(t => t.key === view.value?.recordTypeKey) ?? null)
const canCreate = computed(() => typeInfo.value?.canCreate ?? false)
const canEditDefinition = computed(() =>
  view.value?.accessLevel === 'edit' || view.value?.accessLevel === 'owner')
const isOwner = computed(() => view.value?.accessLevel === 'owner')
const isCustom = computed(() => !!view.value?.definition.columns)

// --- slideover --------------------------------------------------------------

const openRecordId = ref<string | null>(null)

// --- moves ------------------------------------------------------------------

const groupFieldDef = computed(() =>
  view.value?.definition.groupField
    ? fields.value.find(f => f.key === view.value!.definition.groupField) ?? null
    : null)

// Mirrors the server's drag rules (move for single-value and user fields,
// add for multi-selects, tags and connections) so the board lands where the
// card was dropped before the API round-trip confirms it.
function applyOptimisticMove(payload: ViewsMovePayload) {
  const recs = records.value
  if (!recs) return
  const { recordId, fromColumn, toColumn, columnOrder } = payload

  const field = groupFieldDef.value
  const leavesSource = isCustom.value || !field || viewsDragMode(field) === 'move' || toColumn === ''
  const keys = generateNKeysBetween(null, null, columnOrder.length)
  const inOrder = new Set(columnOrder)
  const placements = recs.placements.filter((p) => {
    if (p.columnKey === toColumn && inOrder.has(p.recordId)) return false
    if (p.recordId !== recordId) return true
    // The moved card sheds its source placement (custom boards shed all);
    // an add-mode drag keeps it in the column it came from.
    if (isCustom.value) return false
    return !leavesSource || p.columnKey !== fromColumn
  })
  columnOrder.forEach((id, i) => {
    placements.push({ recordId: id, columnKey: toColumn, rank: keys[i]! })
  })
  recs.placements = placements

  if (!isCustom.value && field) {
    const item = recs.items.find(i => i.id === recordId)
    if (item) {
      const single = field.kind === 'key_select' || (field.kind === 'user_select' && !field.multiple)
      const current = item.groupValues ?? []
      if (single) {
        item.groupValues = toColumn === '' ? [] : [toColumn]
      } else if (leavesSource) {
        const next = current.filter(v => v !== fromColumn)
        if (toColumn !== '' && !next.includes(toColumn)) next.push(toColumn)
        item.groupValues = next
      } else if (!current.includes(toColumn)) {
        item.groupValues = [...current, toColumn]
      }
    }
  }
}

async function onMove(payload: ViewsMovePayload) {
  beginDrag()
  try {
    applyOptimisticMove(payload)
    await move(payload)
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Move failed') })
  } finally {
    endDrag()
    refreshRecords()
  }
}

// --- quick add --------------------------------------------------------------

async function onQuickAdd({ columnKey, name }: { columnKey: string, name: string }) {
  const v = view.value
  if (!v) return
  try {
    const recordFields: Record<string, unknown> = { name }
    const field = groupFieldDef.value
    if (!isCustom.value && field && columnKey !== '') {
      const single = field.kind === 'key_select' || (field.kind === 'user_select' && !field.multiple)
      recordFields[field.key] = single ? columnKey : [columnKey]
    }
    const created = await $fetch<{ id: string }>(`/api/records/entries/${v.recordTypeKey}`, {
      method: 'POST',
      body: { fields: recordFields }
    })
    if (isCustom.value) {
      await $fetch(`/api/views/${v.id}/cards`, {
        method: 'POST',
        body: { recordId: created.id, columnKey }
      })
    }
    await refreshRecords()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to create the record') })
  }
}

// --- connection columns -----------------------------------------------------

// A connection-grouped board's columns are records of the target type, so a
// new column is a new target record (the records create route checks the
// caller may create one).
async function onAddTargetColumn(label: string) {
  const target = groupFieldDef.value?.target
  if (!target) return
  try {
    await $fetch(`/api/records/entries/${target}`, { method: 'POST', body: { fields: { name: label } } })
    await refreshRecords()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to add the column') })
  }
}

// --- custom board membership ------------------------------------------------

const addCardColumn = ref<string | null>(null)

async function onRemoveCard(recordId: string) {
  const v = view.value
  if (!v) return
  try {
    await $fetch(`/api/views/${v.id}/cards/${recordId}`, { method: 'DELETE' })
    await refreshRecords()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to remove the card') })
  }
}

// --- definition + meta updates ----------------------------------------------

async function patchView(body: Record<string, unknown>, failure: string): Promise<boolean> {
  const v = view.value
  if (!v) return false
  try {
    await $fetch(`/api/views/${v.id}`, { method: 'PATCH', body })
    await refresh()
    return true
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, failure) })
    return false
  }
}

function onColumnsChange(columns: ViewsColumnDef[]) {
  const v = view.value
  if (!v) return
  patchView(
    { definition: { ...v.definition, columns } },
    'Failed to update columns'
  )
}

const cardFieldsOpen = ref(false)

function onCardFieldsChange(layout: { cardFields: string[], cardConnections: Record<string, ViewsConnectionDisplay> } | null) {
  const v = view.value
  if (!v) return
  const definition = { ...v.definition }
  delete definition.cardFields
  delete definition.cardConnections
  if (layout) {
    definition.cardFields = layout.cardFields
    if (Object.keys(layout.cardConnections).length > 0) definition.cardConnections = layout.cardConnections
  }
  patchView({ definition }, 'Failed to update the fields')
}

function onDefinitionSort(sort: { field: string, dir: 'asc' | 'desc' } | null) {
  const v = view.value
  if (!v) return
  const definition = { ...v.definition }
  if (sort) definition.sort = sort
  else delete definition.sort
  patchView({ definition }, 'Failed to save the sort order')
}

const groupFieldOpen = ref(false)
// A field-grouped board — the only kind that has a grouping field to change.
const isFieldGrouped = computed(() =>
  view.value?.viewType === 'kanban' && !isCustom.value)

function onGroupFieldChange(groupField: string) {
  const v = view.value
  if (!v) return
  // Keys of a deleted field can still sit in the rest of the definition and
  // would fail validation, taking the repair down with them.
  const definition = viewsPruneDefinition({ ...v.definition, groupField }, fields.value)
  patchView({ definition }, 'Failed to change the grouping field')
}

// --- header menu ------------------------------------------------------------

const renameOpen = ref(false)
const renameValue = ref('')
const renameIcon = ref<string | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)

function openRename() {
  renameValue.value = view.value?.name ?? ''
  renameIcon.value = view.value?.icon ?? null
  renameOpen.value = true
}
async function submitRename() {
  const name = renameValue.value.trim()
  if (!name) return
  const saved = await patchView(
    { name, icon: renameIcon.value },
    'Failed to rename the view'
  )
  if (saved) renameOpen.value = false
}

async function setVisibility(visibility: ViewsVisibility) {
  await patchView({ visibility }, 'Failed to change visibility')
}

// --- leaving a shared view --------------------------------------------------

const { user } = useAuth()
const myUserId = computed<string | null>(() => (user.value as { id?: string } | null)?.id ?? null)
const leaveOpen = ref(false)
const leaving = ref(false)

async function leaveView() {
  const v = view.value
  const userId = myUserId.value
  if (!v || !userId || leaving.value) return
  leaving.value = true
  try {
    await $fetch(`/api/views/${v.id}/shares/${userId}`, { method: 'DELETE' })
    await navigateTo(viewsPath(''))
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to leave the view') })
    leaving.value = false
  }
}

async function deleteView() {
  const v = view.value
  if (!v || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/views/${v.id}`, { method: 'DELETE' })
    await navigateTo(viewsPath(''))
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to delete the view') })
    deleting.value = false
  }
}

const VISIBILITY_META: Record<ViewsVisibility, { label: string, icon: string }> = {
  private: { label: 'Private', icon: 'i-lucide-lock' },
  shared: { label: 'Shared', icon: 'i-lucide-users' },
  org: { label: 'Organization', icon: 'i-lucide-building-2' }
}

const menuItems = computed(() => {
  const items: Array<Array<Record<string, unknown>>> = []
  if (canEditDefinition.value) {
    items.push([
      { label: 'Rename & icon', icon: 'i-lucide-pencil', onSelect: openRename },
      {
        label: view.value?.viewType === 'table' ? 'Table columns' : 'Card fields',
        icon: 'i-lucide-list-checks',
        onSelect: () => {
          cardFieldsOpen.value = true
        }
      }
    ])
    if (isFieldGrouped.value) {
      items[items.length - 1]!.push({
        label: 'Change grouping',
        icon: 'i-lucide-columns-3',
        onSelect: () => {
          groupFieldOpen.value = true
        }
      })
    }
  }
  if (isOwner.value) {
    items.push([
      {
        label: 'Visibility',
        icon: VISIBILITY_META[view.value?.visibility ?? 'private'].icon,
        children: (Object.keys(VISIBILITY_META) as ViewsVisibility[]).map(key => ({
          label: VISIBILITY_META[key].label,
          icon: VISIBILITY_META[key].icon,
          type: 'checkbox' as const,
          checked: view.value?.visibility === key,
          onSelect: () => setVisibility(key)
        }))
      }
    ])
    items.push([{
      label: 'Delete view',
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => {
        deleteOpen.value = true
      }
    }])
  } else if (view.value?.sharedWithMe) {
    items.push([{
      label: 'Leave view',
      icon: 'i-lucide-log-out',
      color: 'error',
      onSelect: () => {
        leaveOpen.value = true
      }
    }])
  }
  return items
})
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8 overflow-hidden">
    <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
      <UButton
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back to views"
        :to="viewsPath('')"
      />
      <UIcon
        :name="view?.icon || (view?.viewType === 'kanban' ? 'i-lucide-kanban' : 'i-lucide-table')"
        class="size-5 text-(--ui-text-muted)"
      />
      <h1 class="text-lg font-semibold truncate">
        {{ view?.name ?? '…' }}
      </h1>
      <UBadge
        v-if="view"
        variant="subtle"
        color="neutral"
        :icon="VISIBILITY_META[view.visibility].icon"
        class="hidden sm:inline-flex"
      >
        {{ VISIBILITY_META[view.visibility].label }}
      </UBadge>
      <span class="flex-1" />
      <ViewsShareMenu
        v-if="view && canEditDefinition"
        :view="view"
        @changed="refresh"
      />
      <UDropdownMenu
        v-if="menuItems.length > 0"
        :items="menuItems"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="View options"
        />
      </UDropdownMenu>
    </header>

    <ViewsFilterBar
      v-if="view"
      v-model:q="q"
      v-model:personal-filters="personalFilters"
      :view="view"
      :fields="fields"
      :can-edit-definition="canEditDefinition"
      @definition-filters="patchView({ definition: { ...view!.definition, filters: $event } }, 'Failed to save filters')"
      @definition-sort="onDefinitionSort"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="error"
      class="m-4"
    />

    <div
      v-else-if="records?.groupFieldMissing"
      class="grid place-items-center flex-1 text-(--ui-text-muted)"
    >
      <div class="text-center max-w-sm space-y-3">
        <UIcon
          name="i-lucide-columns-3"
          class="size-10 opacity-50"
        />
        <p class="text-sm">
          This board's grouping field no longer exists on the record type.
          <template v-if="canEditDefinition">
            Pick a new grouping field to bring it back.
          </template>
        </p>
        <UButton
          v-if="canEditDefinition"
          icon="i-lucide-columns-3"
          @click="groupFieldOpen = true"
        >
          Choose a grouping field
        </UButton>
      </div>
    </div>

    <div
      v-else
      class="flex-1 min-h-0 p-4"
    >
      <UAlert
        v-if="records?.truncated"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`Showing ${records.items.length} of ${records.total} records — add filters to narrow the view.`"
        class="mb-3"
      />

      <ViewsKanbanBoard
        v-if="view?.viewType === 'kanban' && records"
        :view="view"
        :records="records"
        :fields="fields"
        :can-edit-definition="canEditDefinition"
        :can-create="canCreate"
        @move="onMove"
        @open="openRecordId = $event"
        @quick-add="onQuickAdd"
        @add-existing="addCardColumn = $event"
        @columns-change="onColumnsChange"
        @add-target-column="onAddTargetColumn"
        @remove-card="onRemoveCard"
        @dragstart="beginDrag"
        @dragend="endDrag"
      />

      <ViewsTableView
        v-else-if="view?.viewType === 'table' && records"
        v-model:page="page"
        :view="view"
        :records="records"
        :fields="fields"
        :sort="sort"
        :dir="dir"
        :page-size="pageSize"
        :pending="pending"
        :can-create="canCreate"
        @toggle-sort="(field: string) => {
          if (sort === field) dir = dir === 'asc' ? 'desc' : 'asc'
          else { sort = field; dir = 'asc' }
        }"
        @open="openRecordId = $event"
        @quick-add="onQuickAdd({ columnKey: '', name: $event })"
      />
    </div>

    <ViewsRecordSlideover
      v-if="view"
      v-model:record-id="openRecordId"
      :type-key="view.recordTypeKey"
      @changed="refreshRecords"
    />

    <ViewsAddCardModal
      v-if="view"
      v-model:column-key="addCardColumn"
      :view="view"
      :on-board="records ? records.placements.map(p => p.recordId) : []"
      @added="refreshRecords"
    />

    <ViewsCardFieldsModal
      v-if="view && records"
      v-model:open="cardFieldsOpen"
      :view="view"
      :fields="fields"
      :layout="records.card"
      @save="onCardFieldsChange"
    />

    <ViewsGroupFieldModal
      v-if="view && isFieldGrouped"
      v-model:open="groupFieldOpen"
      :view="view"
      :fields="fields"
      @save="onGroupFieldChange"
    />

    <UModal v-model:open="renameOpen">
      <template #content>
        <form
          class="p-6 space-y-4"
          @submit.prevent="submitRename"
        >
          <h2 class="text-lg font-semibold">
            Name & icon
          </h2>
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="renameValue"
              autofocus
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Icon"
            help="Shown in the views list and this view's header. Leave empty for the default."
          >
            <IconPicker v-model="renameIcon" />
          </UFormField>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="renameOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :disabled="!renameValue.trim()"
            >
              Save
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <UModal v-model:open="leaveOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Leave this view?
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            "{{ view?.name }}" disappears from your views. Only its owner can
            share it with you again.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="leaving"
              @click="leaveOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="leaving"
              @click="leaveView"
            >
              Leave
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="deleteOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Delete this view?
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            "{{ view?.name }}" and its sharing settings will be removed. The
            records it shows are not touched.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="deleteView"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
