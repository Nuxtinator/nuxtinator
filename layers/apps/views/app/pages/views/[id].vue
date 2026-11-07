<script setup lang="ts">
// One open view: header (name, its tabs, share, view menu), the active
// tab's toolbar and renderer, and the interaction plumbing — optimistic moves
// with the poll loop suspended while a drag settles, quick-add (through the
// records create route, or as one of a hand-picked view's own cards), the
// list's done checkbox, tab and definition updates, and the view's own
// fields (managed by its owner, filled in by its editors). The active tab
// rides in ?tab= so a tab can be linked to. Writes that would hand a card to
// someone who can't see it ask first (useRecordsShareConfirm).
import { generateNKeysBetween } from 'fractional-indexing'
import { recordsFilterRuleCount } from '#records'
import type { RecordsFieldSetting, RecordsFilterGroup } from '#records/client'
import type {
  ViewsColumnDef,
  ViewsConnectionDisplay,
  ViewsDefinition,
  ViewsTab,
  ViewsTabView
} from '../../utils/views-types'
import { VIEWS_LAYOUT_META, viewsDragMode } from '../../utils/views-types'
import type { ViewsMovePayload } from '../../composables/useViewsDetail'
import type { ViewsTabChoice } from '../../components/views/TabModal.vue'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirmAction = useConfirm()
const viewsPath = useViewsPath()
const viewId = computed(() => String(route.params.id ?? ''))
const requestedTab = computed(() => typeof route.query.tab === 'string' ? route.query.tab : null)

const {
  view, tab, records, pending, error,
  q, sort, dir, page, pageSize,
  refresh, refreshRecords, beginDrag, endDrag, move
} = useViewsDetail(viewId, requestedTab)

function selectTab(id: string) {
  router.replace({ query: { ...route.query, tab: id } })
}

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

// The type's fields followed by the view's own: every picker and renderer
// takes both.
const allFields = computed<RecordsFieldSetting[]>(() =>
  [...fields.value, ...viewsFieldSettings(view.value?.definition.fields)])
const viewFields = computed(() => viewsFieldSettings(view.value?.definition.fields))
const shareConfirm = useRecordsShareConfirm()

// The people this view shows are resolved by id: the shared directory holds
// one page of the org's members, and a record may reference anyone.
const { ensureUserIds } = useRecordsUsers()
watch([records, allFields], ([recs, defs]) => {
  if (!recs || defs.length === 0) return
  const ids = viewsReferencedUserIds(
    recs.items,
    defs,
    tab.value?.definition.groupField ?? null
  )
  if (ids.length > 0) {
    ensureUserIds(ids).catch(() => {
      // Unresolved ids render as "Unknown user"; the board still works.
    })
  }
})

const typeInfo = computed(() =>
  types.value.find(t => t.key === view.value?.recordTypeKey) ?? null)
const canEditDefinition = computed(() =>
  view.value?.accessLevel === 'edit' || view.value?.accessLevel === 'owner')
// Creating takes the type's create permission; on a hand-picked view it also
// takes 'edit' on the view, since the record becomes one of its cards.
const canCreate = computed(() => {
  const typeAllows = typeInfo.value?.canCreate ?? false
  return picked.value ? typeAllows && canEditDefinition.value : typeAllows
})
const isOwner = computed(() => view.value?.accessLevel === 'owner')
const picked = computed(() => !!view.value?.definition.picked)

/** The active tab in the shape the renderers take. */
const tabView = computed<ViewsTabView | null>(() => {
  const v = view.value
  const t = tab.value
  if (!v || !t) return null
  return {
    id: v.id,
    tabId: t.id,
    recordTypeKey: v.recordTypeKey,
    viewType: t.layout,
    definition: t.definition,
    picked: !!v.definition.picked
  }
})
const layout = computed(() => tab.value?.layout ?? null)
const isCustom = computed(() => !!tab.value?.definition.columns)
// The feed belongs to the tab on screen; a poll for the previous tab can't
// render under the new one.
const tabRecords = computed(() =>
  records.value && records.value.tabId === tab.value?.id ? records.value : null)

// --- slideover --------------------------------------------------------------

const openRecordId = ref<string | null>(null)

// --- moves ------------------------------------------------------------------

const groupFieldDef = computed(() =>
  tab.value?.definition.groupField
    ? allFields.value.find(f => f.key === tab.value!.definition.groupField) ?? null
    : null)

// Mirrors the server's drag rules (move for single-value and user fields,
// add for multi-selects, tags and connections) so the tab shows the card
// where it was dropped before the API round-trip confirms it.
function applyOptimisticMove(payload: ViewsMovePayload) {
  const recs = tabRecords.value
  if (!recs) return
  const { recordId, fromColumn, toColumn, columnOrder } = payload

  const field = groupFieldDef.value
  const leavesSource = isCustom.value || !field || viewsDragMode(field) === 'move' || toColumn === ''
  const keys = generateNKeysBetween(null, null, columnOrder.length)
  const inOrder = new Set(columnOrder)
  const placements = recs.placements.filter((p) => {
    if (p.columnKey === toColumn && inOrder.has(p.recordId)) return false
    if (p.recordId !== recordId) return true
    // The moved card sheds its source placement (own-column boards shed
    // all); an add-mode drag keeps it in the column it came from.
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
  // Reordering within a column is view state, which view-only access can't change.
  if (!canEditDefinition.value && payload.fromColumn === payload.toColumn) return
  beginDrag()
  try {
    applyOptimisticMove(payload)
    await shareConfirm(confirmShare => move({ ...payload, confirmShare }))
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
  const t = tab.value
  if (!v || !t) return
  try {
    // The new record takes the values the view's and tab's filters pin, so it
    // shows up on the tab it was added from.
    const pinnedValues: Record<string, unknown> = {
      ...viewsFilterPrefill([v.definition.filter, t.definition.filter], allFields.value, myUserId.value),
      name
    }
    const field = groupFieldDef.value
    if (!isCustom.value && field) {
      const single = field.kind === 'key_select' || (field.kind === 'user_select' && !field.multiple)
      const pinned = Array.isArray(pinnedValues[field.key]) ? pinnedValues[field.key] as unknown[] : []
      // "No value" is a value: an explicit null keeps the type's default
      // (a task's "open") from putting the new record in another column.
      if (columnKey !== '') pinnedValues[field.key] = single ? columnKey : [...new Set([...pinned, columnKey])]
      else if (single) pinnedValues[field.key] = null
      else delete pinnedValues[field.key]
    }
    // Values of the view's own fields go to the view, not the record.
    const recordFields: Record<string, unknown> = {}
    const viewValues: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(pinnedValues)) {
      if (key.startsWith(VIEWS_FIELD_KEY_PREFIX)) {
        if (value !== null) viewValues[key] = value
      } else {
        recordFields[key] = value
      }
    }
    if (picked.value) {
      await shareConfirm(confirmShare => $fetch(`/api/views/${v.id}/cards`, {
        method: 'POST',
        body: {
          fields: recordFields,
          viewValues,
          confirmShare,
          tabId: t.id,
          columnKey: isCustom.value ? columnKey : undefined
        }
      }))
      await refreshRecords()
      return
    }
    const created = await shareConfirm(confirmShare => $fetch<{ id: string }>(`/api/records/entries/${v.recordTypeKey}`, {
      method: 'POST',
      body: { fields: recordFields, confirmShare }
    }))
    if (!created) return
    if (Object.keys(viewValues).length > 0 && canEditDefinition.value) {
      await $fetch(`/api/views/${v.id}/values/${created.id}`, { method: 'PATCH', body: { values: viewValues } })
    }
    if (isCustom.value && columnKey !== '') {
      // Own columns on a view of every matching record: the new card's
      // column is its placement, at the end of the column it was added from.
      const inColumn = (tabRecords.value?.placements ?? [])
        .filter(p => p.columnKey === columnKey && p.recordId !== created.id)
        .sort((a, b) => (a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0)
        .map(p => p.recordId)
      await move({ recordId: created.id, fromColumn: null, toColumn: columnKey, columnOrder: [...inColumn, created.id] })
    }
    await refreshRecords()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to create the record') })
  }
}

// --- list checkbox ----------------------------------------------------------

// Types with exactly one closed status get a done checkbox; unticking goes
// back to the status field's default, else its first open option.
const doneStatus = computed(() => {
  const status = fields.value.find(f => f.column === 'status')
  if (!status?.options) return null
  const options = Object.entries(status.options).filter(([, o]) => !o.deleted)
  const closed = options.filter(([, o]) => o.closed)
  if (closed.length !== 1) return null
  const open = options.filter(([, o]) => !o.closed)
  const fallback = typeof status.default === 'string' && open.some(([k]) => k === status.default)
    ? status.default
    : open[0]?.[0]
  if (!fallback) return null
  return { done: closed[0]![0], reopen: fallback }
})

async function onToggleDone({ recordId, done }: { recordId: string, done: boolean }) {
  const v = view.value
  const statuses = doneStatus.value
  if (!v || !statuses) return
  const value = done ? statuses.done : statuses.reopen
  const item = tabRecords.value?.items.find(i => i.id === recordId)
  const previous = item?.status ?? null
  if (item) item.status = value
  try {
    await $fetch(`/api/records/entries/${v.recordTypeKey}/${recordId}`, {
      method: 'PATCH',
      body: { fields: { status: value } }
    })
  } catch (err) {
    if (item) item.status = previous
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to update the record') })
  } finally {
    refreshRecords()
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

// --- hand-picked records ----------------------------------------------------

const addCardColumn = ref<string | null>(null)

// A card created on this view (and on no other) is deleted, after a confirm;
// any other card only comes off the view.
async function onRemoveCard(recordId: string) {
  const v = view.value
  if (!v) return
  const card = tabRecords.value?.items.find(i => i.id === recordId)
  if (card?.ownCard) {
    if (!await confirmAction({ title: `Delete "${card.name}"?`, confirmLabel: 'Delete', color: 'error' })) return
  }
  try {
    await $fetch(`/api/views/${v.id}/cards/${recordId}`, {
      method: 'DELETE',
      query: card?.ownCard ? { record: 'delete' } : undefined
    })
    await refreshRecords()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, card?.ownCard ? 'Failed to delete the card' : 'Failed to remove the record') })
  }
}

// --- view + tab updates -----------------------------------------------------

const saving = ref(false)

async function patchView(body: Record<string, unknown>, failure: string): Promise<boolean> {
  const v = view.value
  if (!v) return false
  saving.value = true
  try {
    await $fetch(`/api/views/${v.id}`, { method: 'PATCH', body })
    await refresh()
    return true
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, failure) })
    return false
  } finally {
    saving.value = false
  }
}

async function patchTab(body: Record<string, unknown>, failure: string, tabId = tab.value?.id): Promise<boolean> {
  const v = view.value
  if (!v || !tabId) return false
  saving.value = true
  try {
    await $fetch(`/api/views/${v.id}/tabs/${tabId}`, { method: 'PATCH', body })
    await refresh()
    return true
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, failure) })
    return false
  } finally {
    saving.value = false
  }
}

function patchTabDefinition(change: (definition: ViewsDefinition) => void, failure: string) {
  const t = tab.value
  if (!t) return
  const definition: ViewsDefinition = structuredClone(toRaw(t.definition))
  change(definition)
  patchTab({ definition }, failure)
}

function onColumnsChange(columns: ViewsColumnDef[]) {
  patchTabDefinition((d) => {
    d.columns = columns
  }, 'Failed to update columns')
}

const cardFieldsOpen = ref(false)

function onCardFieldsChange(layout: { cardFields: string[], cardConnections: Record<string, ViewsConnectionDisplay> } | null) {
  patchTabDefinition((d) => {
    delete d.cardFields
    delete d.cardConnections
    if (layout) {
      d.cardFields = layout.cardFields
      if (Object.keys(layout.cardConnections).length > 0) d.cardConnections = layout.cardConnections
    }
  }, 'Failed to update the fields')
}

function onTabSort(next: { field: string, dir: 'asc' | 'desc' } | null) {
  patchTabDefinition((d) => {
    if (next) d.sort = next
    else delete d.sort
  }, 'Failed to save the sort order')
}

function onTabFilter(filter: RecordsFilterGroup | null) {
  patchTabDefinition((d) => {
    if (filter) d.filter = filter
    else delete d.filter
  }, 'Failed to save the filter')
}

const viewFilterOpen = ref(false)
async function onViewFilter(filter: RecordsFilterGroup | null) {
  const saved = await patchView({ definition: { filter: filter ?? undefined } }, 'Failed to save the view filter')
  if (saved) viewFilterOpen.value = false
}

const groupFieldOpen = ref(false)
// Tabs whose grouping is a field — the only ones with a grouping field to repair.
const isFieldGrouped = computed(() =>
  (layout.value === 'kanban' && !isCustom.value) || (layout.value === 'list' && !!tab.value?.definition.groupField))

function onGroupFieldChange(groupField: string) {
  const t = tab.value
  if (!t) return
  // Keys of a deleted field can still sit in the rest of the definition and
  // would fail validation, taking the repair down with them.
  const definition = viewsPruneDefinition({ ...t.definition, groupField }, allFields.value)
  patchTab({ definition }, 'Failed to change the grouping field')
}

// --- tabs -------------------------------------------------------------------

const tabModalOpen = ref(false)
const tabModalTab = ref<ViewsTab | null>(null)

function openNewTab() {
  tabModalTab.value = null
  tabModalOpen.value = true
}

function openTabSettings(t: ViewsTab) {
  tabModalTab.value = t
  tabModalOpen.value = true
}

// Fresh custom-column boards of a hand-picked view start with the classic
// three columns; elsewhere they start with just the "No column" lane.
const DEFAULT_COLUMNS: ViewsColumnDef[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

function definitionFor(choice: ViewsTabChoice, base: ViewsDefinition): ViewsDefinition {
  const definition: ViewsDefinition = structuredClone(toRaw(base))
  delete definition.groupField
  if (!choice.ownColumns) delete definition.columns
  if (choice.ownColumns && !definition.columns) definition.columns = picked.value ? DEFAULT_COLUMNS : []
  if (choice.groupField) definition.groupField = choice.groupField
  return definition
}

async function onTabSave(choice: ViewsTabChoice) {
  const v = view.value
  if (!v) return
  const existing = tabModalTab.value
  if (existing) {
    const saved = await patchTab({
      name: choice.name,
      layout: choice.layout,
      definition: definitionFor(choice, existing.definition)
    }, 'Failed to save the tab', existing.id)
    if (saved) tabModalOpen.value = false
    return
  }
  saving.value = true
  try {
    const created = await $fetch<ViewsTab>(`/api/views/${v.id}/tabs`, {
      method: 'POST',
      body: { name: choice.name, layout: choice.layout, definition: definitionFor(choice, {}) }
    })
    await refresh()
    tabModalOpen.value = false
    selectTab(created.id)
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to add the tab') })
  } finally {
    saving.value = false
  }
}

async function deleteTab(t: ViewsTab) {
  const v = view.value
  if (!v) return
  if (!await confirmAction({ title: `Delete the "${t.name}" tab?`, confirmLabel: 'Delete', color: 'error' })) return
  try {
    await $fetch(`/api/views/${v.id}/tabs/${t.id}`, { method: 'DELETE' })
    if (tab.value?.id === t.id) {
      const rest = v.tabs.filter(x => x.id !== t.id)
      if (rest[0]) selectTab(rest[0].id)
    }
    await refresh()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to delete the tab') })
  }
}

async function shiftTab(t: ViewsTab, by: -1 | 1) {
  const v = view.value
  if (!v) return
  const ids = v.tabs.map(x => x.id)
  const from = ids.indexOf(t.id)
  const to = from + by
  if (from < 0 || to < 0 || to >= ids.length) return
  ids.splice(from, 1)
  ids.splice(to, 0, t.id)
  try {
    await $fetch(`/api/views/${v.id}/tab-order`, { method: 'PUT', body: { tabIds: ids } })
    await refresh()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to move the tab') })
  }
}

function tabMenu(t: ViewsTab) {
  const tabs = view.value?.tabs ?? []
  const index = tabs.findIndex(x => x.id === t.id)
  const items: Array<Array<Record<string, unknown>>> = [[
    { label: 'Tab settings', icon: 'i-lucide-settings-2', onSelect: () => openTabSettings(t) },
    {
      label: t.layout === 'table' ? 'Table columns' : t.layout === 'list' ? 'Row fields' : 'Card fields',
      icon: 'i-lucide-list-checks',
      onSelect: () => {
        selectTab(t.id)
        cardFieldsOpen.value = true
      }
    }
  ]]
  const moves: Array<Record<string, unknown>> = []
  if (index > 0) moves.push({ label: 'Move left', icon: 'i-lucide-arrow-left', onSelect: () => shiftTab(t, -1) })
  if (index < tabs.length - 1) moves.push({ label: 'Move right', icon: 'i-lucide-arrow-right', onSelect: () => shiftTab(t, 1) })
  if (moves.length > 0) items.push(moves)
  if (tabs.length > 1) {
    items.push([{ label: 'Delete tab', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => deleteTab(t) }])
  }
  return items
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

const viewFilterCount = computed(() => recordsFilterRuleCount(view.value?.definition.filter))

// --- the view's own fields + copying ----------------------------------------

const fieldsOpen = ref(false)

// A private copy of this view's structure — fields, tabs, columns, filters —
// with no cards, opened straight away.
async function copyCurrentView() {
  const v = view.value
  if (!v) return
  try {
    const copy = await $fetch<{ id: string }>(`/api/views/${v.id}/copy`, { method: 'POST', body: {} })
    await navigateTo(viewsPath(`/${copy.id}`))
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to copy the view') })
  }
}

const menuItems = computed(() => {
  const items: Array<Array<Record<string, unknown>>> = []
  const main: Array<Record<string, unknown>> = []
  if (canEditDefinition.value) {
    main.push({ label: 'Rename & icon', icon: 'i-lucide-pencil', onSelect: openRename })
  }
  main.push({
    label: viewFilterCount.value > 0 ? `View filter · ${viewFilterCount.value}` : 'View filter',
    icon: 'i-lucide-list-filter',
    onSelect: () => {
      viewFilterOpen.value = true
    }
  })
  main.push({
    label: viewFields.value.length > 0 ? `Fields · ${viewFields.value.length}` : 'Fields',
    icon: 'i-lucide-text-cursor-input',
    onSelect: () => {
      fieldsOpen.value = true
    }
  })
  if (canEditDefinition.value && isFieldGrouped.value) {
    main.push({
      label: 'Change grouping',
      icon: 'i-lucide-columns-3',
      onSelect: () => {
        groupFieldOpen.value = true
      }
    })
  }
  items.push(main)
  items.push([{ label: 'Copy view', icon: 'i-lucide-copy', onSelect: copyCurrentView }])
  if (isOwner.value) {
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
    <header class="flex items-center gap-2 px-4 py-2 border-b border-(--ui-border) bg-(--ui-bg)">
      <UButton
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back to views"
        :to="viewsPath('')"
      />
      <UIcon
        :name="view?.icon || VIEWS_LAYOUT_META[view?.tabs[0]?.layout ?? 'list'].icon"
        class="size-5 text-(--ui-text-muted) shrink-0"
      />
      <h1 class="text-lg font-semibold truncate shrink-0 max-w-[30%]">
        {{ view?.name ?? '…' }}
      </h1>

      <nav
        v-if="view"
        class="flex items-center gap-1 ml-2 min-w-0 overflow-x-auto"
        aria-label="Tabs"
      >
        <div
          v-for="t in view.tabs"
          :key="t.id"
          class="flex items-center shrink-0 rounded-md"
          :class="t.id === tab?.id ? 'bg-(--ui-bg-elevated)' : ''"
        >
          <UButton
            :icon="VIEWS_LAYOUT_META[t.layout].icon"
            variant="ghost"
            :color="t.id === tab?.id ? 'primary' : 'neutral'"
            size="sm"
            :aria-current="t.id === tab?.id ? 'page' : undefined"
            @click="selectTab(t.id)"
          >
            {{ t.name }}
          </UButton>
          <UDropdownMenu
            v-if="canEditDefinition && t.id === tab?.id"
            :items="tabMenu(t)"
          >
            <UButton
              icon="i-lucide-chevron-down"
              variant="ghost"
              color="neutral"
              size="xs"
              :aria-label="`${t.name} tab options`"
            />
          </UDropdownMenu>
        </div>
        <UButton
          v-if="canEditDefinition"
          icon="i-lucide-plus"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Add tab"
          @click="openNewTab"
        />
      </nav>

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
      v-if="view && tabView"
      v-model:q="q"
      :view="tabView"
      :view-definition="view.definition"
      :fields="allFields"
      :can-edit-definition="canEditDefinition"
      :saving="saving"
      @definition-filter="onTabFilter"
      @definition-sort="onTabSort"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="error"
      class="m-4"
    />

    <div
      v-else-if="tabRecords?.groupFieldMissing"
      class="grid place-items-center flex-1 text-(--ui-text-muted)"
    >
      <div class="text-center max-w-sm space-y-3">
        <UIcon
          name="i-lucide-columns-3"
          class="size-10 opacity-50"
        />
        <p class="text-sm">
          This tab's grouping field no longer exists on the record type.
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
        v-if="tabRecords?.truncated"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`Showing ${tabRecords.items.length} of ${tabRecords.total} records — add filters to narrow the view.`"
        class="mb-3"
      />

      <ViewsKanbanBoard
        v-if="layout === 'kanban' && tabView && tabRecords"
        :view="tabView"
        :records="tabRecords"
        :fields="allFields"
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

      <div
        v-else-if="layout === 'list' && tabView && tabRecords"
        class="h-full flex flex-col gap-2"
      >
        <div
          v-if="picked"
          class="flex justify-end"
        >
          <UButton
            icon="i-lucide-plus"
            variant="outline"
            color="neutral"
            size="sm"
            @click="addCardColumn = ''"
          >
            Add existing
          </UButton>
        </div>
        <ViewsListView
          class="flex-1 min-h-0"
          :view="tabView"
          :records="tabRecords"
          :fields="allFields"
          :can-create="canCreate"
          :can-remove="canEditDefinition"
          :done-status="doneStatus"
          @move="onMove"
          @open="openRecordId = $event"
          @quick-add="onQuickAdd"
          @toggle-done="onToggleDone"
          @remove-card="onRemoveCard"
          @dragstart="beginDrag"
          @dragend="endDrag"
        />
      </div>

      <ViewsTableView
        v-else-if="layout === 'table' && tabView && tabRecords"
        v-model:page="page"
        :view="tabView"
        :records="tabRecords"
        :fields="allFields"
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
      :view-id="view.id"
      :view-name="view.name"
      :view-fields="viewFields"
      :view-values="tabRecords?.items.find(i => i.id === openRecordId)?.viewValues"
      :can-edit-view="canEditDefinition"
      @changed="refreshRecords"
    />

    <ViewsFieldsModal
      v-if="view"
      v-model:open="fieldsOpen"
      :view-id="view.id"
      :fields="view.definition.fields ?? []"
      :readonly="!isOwner"
      @changed="refresh"
    />

    <ViewsAddCardModal
      v-if="tabView"
      v-model:column-key="addCardColumn"
      :view="tabView"
      :on-board="tabRecords ? tabRecords.items.map(i => i.id) : []"
      @added="refreshRecords"
    />

    <ViewsCardFieldsModal
      v-if="tabView && tabRecords"
      v-model:open="cardFieldsOpen"
      :view="tabView"
      :fields="allFields"
      :layout="tabRecords.card"
      @save="onCardFieldsChange"
    />

    <ViewsGroupFieldModal
      v-if="tabView && isFieldGrouped"
      v-model:open="groupFieldOpen"
      :view="tabView"
      :fields="allFields"
      @save="onGroupFieldChange"
    />

    <ViewsTabModal
      v-if="view"
      v-model:open="tabModalOpen"
      :tab="tabModalTab"
      :fields="allFields"
      :saving="saving"
      @save="onTabSave"
    />

    <ViewsFilterModal
      v-if="view"
      v-model:open="viewFilterOpen"
      :title="isOwner ? 'Filter for every tab' : 'This view\'s filter'"
      :fields="allFields"
      :filter="view.definition.filter ?? null"
      :readonly="!isOwner"
      :saving="saving"
      @save="onViewFilter"
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
          <p
            v-if="view?.ownCardCount"
            class="text-sm text-(--ui-text-muted)"
          >
            "{{ view.name }}", its tabs, its sharing settings and the
            {{ view.ownCardCount === 1 ? 'card' : `${view.ownCardCount} cards` }} created on it
            will be deleted. Cards added from elsewhere, or also on another view, are kept.
          </p>
          <p
            v-else
            class="text-sm text-(--ui-text-muted)"
          >
            "{{ view?.name }}", its tabs and its sharing settings will be
            removed. The records it shows are not touched.
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
              {{ view?.ownCardCount ? `Delete view and ${view.ownCardCount === 1 ? 'card' : `${view.ownCardCount} cards`}` : 'Delete' }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
