<script setup lang="ts">
import { useActiveOrg } from '#tenant'
import ProjectsBoard from '../../components/kanban/ProjectsBoard.vue'
import ProjectsSidebar from '../../components/kanban/ProjectsSidebar.vue'
import CardEditSidePanel from '../../components/kanban/CardEditSidePanel.vue'
import KanbanContextMenu from '../../components/kanban/KanbanContextMenu.vue'
import type {
  KanbanCardModel as Card,
  KanbanColumnModel as Column,
  KanbanSwimlaneModel as Swimlane,
  KanbanProjectModel as Project
} from '../../components/kanban/types'

const toast = useToast()

definePageMeta({
  middleware: 'auth'
})

// Scope key for collapse / row-height localStorage. In multi-mode this is
// the active org slug, so per-org UI state survives org switches without
// crosstalk. In single-mode it falls back to a constant.
const { slug: orgSlug } = useActiveOrg()
const scope = computed(() => orgSlug.value ?? 'default')

// ---------- Project selection (sidebar) ----------
const route = useRoute()
const router = useRouter()
const sidebarOpen = ref(false)

// The focused project lives in the `project` query param so a single-project
// board is deep-linkable and survives reloads. null = all-projects view.
const selectedProjectId = computed(() =>
  typeof route.query.project === 'string' ? route.query.project : null
)
function selectProject(id: string | null) {
  router.replace({ query: { ...route.query, project: id ?? undefined } })
}

// ---------- Ctrl+scroll zoom ----------
const zoomLevel = ref(100)

function handleWheel(event: WheelEvent) {
  if (!event.ctrlKey) return
  event.preventDefault()
  const delta = -Math.sign(event.deltaY)
  zoomLevel.value = Math.max(50, Math.min(200, zoomLevel.value + delta * 5))
}

onMounted(() => {
  if (import.meta.client) {
    window.addEventListener('wheel', handleWheel, { passive: false })
  }
})

onUnmounted(() => {
  if (import.meta.client) {
    window.removeEventListener('wheel', handleWheel)
  }
})

const projects = ref<Project[]>([])
const columns = ref<Column[]>([])
const swimlanes = ref<Swimlane[]>([])
const cards = ref<Card[]>([])
const assignableUsers = ref<{ id: string, display_name: string | null }[]>([])
const loading = ref(true)
const error = ref('')

const cardPanelOpen = ref(false)
const activeCard = ref<Card | null>(null)

// An unknown/stale query id (deleted project, org switch) falls back to the
// all-projects view rather than an empty board.
const selectedProject = computed(() =>
  projects.value.find(p => p.id === selectedProjectId.value) ?? null
)
const visibleProjects = computed(() =>
  selectedProject.value ? [selectedProject.value] : projects.value
)

// Per-project count of cards sitting in FEEDBACK INBOX, shown as sidebar
// badges. The column is mandatory and rename-protected, so matching on its
// name is stable (same pattern as the ARCHIVE lookup in archiveCard).
const inboxCounts = computed<Record<string, number>>(() => {
  const inboxCol = columns.value.find(c => c.name === 'FEEDBACK INBOX')
  const counts: Record<string, number> = {}
  if (!inboxCol) return counts
  for (const c of cards.value) {
    if (c.column_id === inboxCol.id) counts[c.project_id] = (counts[c.project_id] ?? 0) + 1
  }
  return counts
})

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [projectsRes, columnsRes, assigneesRes] = await Promise.all([
      $fetch<Project[]>('/api/feedback/projects'),
      $fetch<Column[]>('/api/feedback/columns'),
      $fetch<{ users: { id: string, display_name: string | null }[] }>('/api/feedback/assignees')
        .catch(() => ({ users: [] }))
    ])

    projects.value = projectsRes
    columns.value = columnsRes
    assignableUsers.value = assigneesRes.users

    const laneResults = await Promise.all(
      projects.value.map(p => $fetch<Swimlane[]>('/api/feedback/swimlanes', { query: { project_id: p.id } }))
    )
    swimlanes.value = laneResults.flat()

    const cardResults = await Promise.all(
      projects.value.map(p => $fetch<Card[]>('/api/feedback/cards', { query: { project_id: p.id } }))
    )
    cards.value = cardResults.flat()
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || 'Failed to load board'
  } finally {
    loading.value = false
  }
}

const pollPaused = computed(
  () => cardPanelOpen.value || projectModalOpen.value || swimlaneModalOpen.value || cardModalOpen.value || settingsModalOpen.value
)

async function refreshCards() {
  if (loading.value) return
  try {
    const cardResults = await Promise.all(
      projects.value.map(p => $fetch<Card[]>('/api/feedback/cards', { query: { project_id: p.id } }))
    )
    cards.value = cardResults.flat()
  } catch (err) {
    console.warn('Auto-poll failed:', err)
  }
}

const { start: startPoll, stop: stopPoll } = useBoardPoll(refreshCards, pollPaused, 5000)

onMounted(() => {
  loadAll().then(() => {
    openCardFromQuery()
    startPoll()
  })
})

onUnmounted(() => {
  stopPoll()
})

// Reload when active org changes (multi-tenant).
watch(orgSlug, () => {
  stopPoll()
  loadAll().then(() => startPoll())
})

// ---------- Project modal ----------
const projectModalOpen = ref(false)
const projectForm = ref({
  id: '' as string,
  name: '',
  description: '',
  allowedOrigins: '',
  notifyUserIds: [] as string[],
  mode: 'create' as 'create' | 'edit'
})

// Candidate recipients for the per-project notify picker, shaped for
// USelectMenu (value = user id, label = display name).
const userItems = computed(() =>
  assignableUsers.value.map(u => ({ id: u.id, label: u.display_name || 'Unnamed user' }))
)
const projectBusy = ref(false)

// The allowed-origins textarea accepts one origin per line (commas/spaces also
// split). The server re-validates and normalizes, so loose parsing is fine.
function parseOriginsInput(value: string): string[] {
  return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

function openCreateProject() {
  projectForm.value = { id: '', name: '', description: '', allowedOrigins: '', notifyUserIds: [], mode: 'create' }
  projectModalOpen.value = true
}
function openRenameProject(p: Project) {
  const notify = p.post_meta?.notify_user_ids
  projectForm.value = {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    allowedOrigins: (p.allowed_origins ?? []).join('\n'),
    notifyUserIds: Array.isArray(notify) ? notify.filter((v): v is string => typeof v === 'string') : [],
    mode: 'edit'
  }
  projectModalOpen.value = true
}
async function submitProject() {
  if (!projectForm.value.name.trim()) return
  projectBusy.value = true
  try {
    if (projectForm.value.mode === 'create') {
      const p = await $fetch<Project>('/api/feedback/projects', {
        method: 'POST',
        body: {
          name: projectForm.value.name.trim(),
          description: projectForm.value.description
        }
      })
      projects.value.push(p)
      const lanes = await $fetch<Swimlane[]>('/api/feedback/swimlanes', { query: { project_id: p.id } })
      swimlanes.value.push(...lanes)
    } else {
      // Merge into the project's existing post_meta so the notify list rides
      // alongside other keys (e.g. sort_order) — the PATCH replaces post_meta
      // wholesale, so sending a partial bag would drop them.
      const existing = projects.value.find(x => x.id === projectForm.value.id)
      const post_meta = { ...(existing?.post_meta ?? {}), notify_user_ids: projectForm.value.notifyUserIds }
      const updated = await $fetch<Project>(`/api/feedback/projects/${projectForm.value.id}`, {
        method: 'PATCH',
        body: {
          name: projectForm.value.name.trim(),
          description: projectForm.value.description,
          allowed_origins: parseOriginsInput(projectForm.value.allowedOrigins),
          post_meta
        }
      })
      const i = projects.value.findIndex(x => x.id === updated.id)
      if (i >= 0) projects.value.splice(i, 1, updated)
    }
    projectModalOpen.value = false
  } catch (e: any) {
    toast.add({ title: 'Project save failed', description: e?.data?.statusMessage, color: 'error' })
  } finally {
    projectBusy.value = false
  }
}
async function deleteProject(p: Project) {
  if (!import.meta.client || !confirm(`Delete project "${p.name}" and all its cards + swimlanes?`)) return
  try {
    await $fetch(`/api/feedback/projects/${p.id}`, { method: 'DELETE' })
    projects.value = projects.value.filter(x => x.id !== p.id)
    swimlanes.value = swimlanes.value.filter(s => s.project_id !== p.id)
    cards.value = cards.value.filter(c => c.project_id !== p.id)
    if (selectedProjectId.value === p.id) selectProject(null)
  } catch (e: any) {
    toast.add({ title: 'Delete failed', description: e?.data?.statusMessage, color: 'error' })
  }
}

// Delete the project currently open in the edit modal, then dismiss the modal
// once the delete flow resolves (it no-ops if the user cancels the confirm).
async function deleteProjectFromModal() {
  const p = projects.value.find(x => x.id === projectForm.value.id)
  if (!p) return
  const before = projects.value.length
  await deleteProject(p)
  if (projects.value.length < before) projectModalOpen.value = false
}

// Transient "copied" indicator so the admin gets visual confirmation when they
// grab the project UUID for the feedback web component's `projectId` prop.
const copiedProjectId = ref<string | null>(null)
async function copyProjectId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = id
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copiedProjectId.value = id
  setTimeout(() => {
    if (copiedProjectId.value === id) copiedProjectId.value = null
  }, 1500)
}

// ---------- Feedback settings (org-wide defaults) ----------
const settingsModalOpen = ref(false)
const settingsBusy = ref(false)
// Org-wide fallback recipient list for projects that haven't chosen their own.
const defaultNotifyUserIds = ref<string[]>([])

async function openSettings() {
  settingsModalOpen.value = true
  try {
    const res = await $fetch<{ user_ids: string[] }>('/api/feedback/notify-settings')
    defaultNotifyUserIds.value = res.user_ids
  } catch (e: any) {
    toast.add({ title: 'Failed to load settings', description: e?.data?.statusMessage, color: 'error' })
  }
}

async function saveSettings() {
  settingsBusy.value = true
  try {
    const res = await $fetch<{ user_ids: string[] }>('/api/feedback/notify-settings', {
      method: 'PUT',
      body: { user_ids: defaultNotifyUserIds.value }
    })
    defaultNotifyUserIds.value = res.user_ids
    settingsModalOpen.value = false
    toast.add({ title: 'Settings saved', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Save failed', description: e?.data?.statusMessage, color: 'error' })
  } finally {
    settingsBusy.value = false
  }
}

// ---------- Swimlane modal ----------
const swimlaneModalOpen = ref(false)
const swimlaneForm = ref({ projectId: '', name: '' })
const swimlaneBusy = ref(false)
function openAddSwimlane(projectId: string) {
  swimlaneForm.value = { projectId, name: '' }
  swimlaneModalOpen.value = true
}
async function submitSwimlane() {
  if (!swimlaneForm.value.name.trim()) return
  swimlaneBusy.value = true
  try {
    const lane = await $fetch<Swimlane>('/api/feedback/swimlanes', {
      method: 'POST',
      body: { project_id: swimlaneForm.value.projectId, name: swimlaneForm.value.name.trim() }
    })
    swimlanes.value.push(lane)
    swimlaneModalOpen.value = false
  } catch (e: any) {
    toast.add({ title: 'Create failed', description: e?.data?.statusMessage, color: 'error' })
  } finally {
    swimlaneBusy.value = false
  }
}

// ---------- Card modal ----------
const cardModalOpen = ref(false)
const cardForm = ref({
  title: '',
  columnId: '',
  swimlaneId: '',
  projectId: ''
})
const cardBusy = ref(false)
function openAddCard(payload: { columnId: string; swimlaneId: string; projectId: string }) {
  cardForm.value = { title: '', ...payload }
  cardModalOpen.value = true
}
async function submitCard() {
  if (!cardForm.value.title.trim()) return
  cardBusy.value = true
  try {
    const created = await $fetch<Card>('/api/feedback/cards', {
      method: 'POST',
      body: {
        project_id: cardForm.value.projectId,
        column_id: cardForm.value.columnId,
        swimlane_id: cardForm.value.swimlaneId,
        title: cardForm.value.title.trim(),
        // Feedback-only board; new cards default to a bug, editable in the panel.
        post_meta: { feedback_sub_type: 'bug' }
      }
    })
    cards.value.push(created)
    cardModalOpen.value = false
  } catch (e: any) {
    toast.add({ title: 'Create failed', description: e?.data?.statusMessage, color: 'error' })
  } finally {
    cardBusy.value = false
  }
}

// ---------- Card panel (edit/move) ----------
const { refresh: refreshNotifications } = useNotifications()

function openCard(card: Card) {
  activeCard.value = card
  cardPanelOpen.value = true
  $fetch(`/api/feedback/cards/${card.id}/read`, { method: 'POST' })
    .then(() => refreshNotifications())
    .catch(() => {})
}

// Notification links point at `?card=<id>`; open that card once the board has it.
function openCardFromQuery() {
  const id = route.query.card
  if (typeof id !== 'string') return
  const card = cards.value.find(c => c.id === id)
  if (card) openCard(card)
  router.replace({ query: { ...route.query, card: undefined } })
}
watch(() => route.query.card, () => {
  if (!loading.value) openCardFromQuery()
})
async function onCardDrop(payload: {
  card: Card
  toColumnId: string
  toSwimlaneId: string
  toProjectId: string
}) {
  const idx = cards.value.findIndex(c => c.id === payload.card.id)
  if (idx < 0) return
  const prev = cards.value[idx]!
  const isCrossProject = payload.toProjectId !== payload.card.project_id
  const optimistic: Card = {
    ...prev,
    column_id: payload.toColumnId,
    swimlane_id: payload.toSwimlaneId,
    ...(isCrossProject ? { project_id: payload.toProjectId } : {})
  }
  cards.value.splice(idx, 1, optimistic)
  try {
    const body: Record<string, string> = {
      column_id: payload.toColumnId,
      swimlane_id: payload.toSwimlaneId,
      project_id: payload.toProjectId
    }
    const updated = await $fetch<Card>(`/api/feedback/cards/${payload.card.id}/move`, {
      method: 'PATCH',
      body
    })
    if (isCrossProject) {
      cards.value.splice(cards.value.findIndex(c => c.id === optimistic.id), 1)
      cards.value.push(updated)
    } else {
      const i = cards.value.findIndex(c => c.id === updated.id)
      if (i >= 0) cards.value.splice(i, 1, updated)
    }
    refreshNotifications().catch(() => {})
  } catch (e: any) {
    cards.value.splice(idx, 1, prev)
    toast.add({ title: 'Move failed', description: e?.data?.statusMessage, color: 'error' })
    await loadAll()
  }
}
// Saves the panel's edits, then moves the card when its status or project
// changed, so the move endpoint records the column history.
async function persistCard(card: Card, patch: Partial<Card>): Promise<Card> {
  const { column_id: columnId, project_id: projectId, ...fields } = patch
  let saved = await $fetch<Card>(`/api/feedback/cards/${card.id}`, {
    method: 'PATCH',
    body: fields
  })
  const targetColumn = columnId || saved.column_id
  const targetProject = projectId || saved.project_id
  if (targetColumn && (targetColumn !== saved.column_id || targetProject !== saved.project_id)) {
    saved = await $fetch<Card>(`/api/feedback/cards/${card.id}/move`, {
      method: 'PATCH',
      body: { column_id: targetColumn, swimlane_id: saved.swimlane_id, project_id: targetProject }
    })
  }
  return saved
}

async function onSaveCard(patch: Partial<Card>) {
  if (!activeCard.value) return
  try {
    const updated = await persistCard(activeCard.value, patch)
    const i = cards.value.findIndex(c => c.id === updated.id)
    if (i >= 0) cards.value.splice(i, 1, updated)
    cardPanelOpen.value = false
  } catch (e: any) {
    toast.add({ title: 'Save failed', description: e?.data?.statusMessage, color: 'error' })
  }
}
// The panel keeps its open card and draft; only the board's copy is refreshed.
function onCardReplied(updated: Card) {
  const i = cards.value.findIndex(c => c.id === updated.id)
  if (i >= 0) cards.value.splice(i, 1, updated)
}
async function onDeleteCard(cardId: string) {
  try {
    await $fetch(`/api/feedback/cards/${cardId}`, { method: 'DELETE' })
    cards.value = cards.value.filter(c => c.id !== cardId)
    cardPanelOpen.value = false
  } catch (e: any) {
    toast.add({ title: 'Delete failed', description: e?.data?.statusMessage, color: 'error' })
  }
}

// Archive = move the card into the ARCHIVE column, optimistic with rollback
// (same shape as onCardDrop). The swimlane/project stay put.
async function archiveCard(card: Card) {
  const archiveCol = columns.value.find(c => c.name === 'ARCHIVE')
  if (!archiveCol) {
    toast.add({ title: 'Archive failed', description: 'No ARCHIVE column found', color: 'error' })
    return
  }
  if (card.column_id === archiveCol.id) return
  const idx = cards.value.findIndex(c => c.id === card.id)
  if (idx < 0) return
  const prev = cards.value[idx]!
  cards.value.splice(idx, 1, { ...prev, column_id: archiveCol.id })
  try {
    const updated = await $fetch<Card>(`/api/feedback/cards/${card.id}/move`, {
      method: 'PATCH',
      body: {
        column_id: archiveCol.id,
        swimlane_id: card.swimlane_id,
        project_id: card.project_id
      }
    })
    const i = cards.value.findIndex(c => c.id === updated.id)
    if (i >= 0) cards.value.splice(i, 1, updated)
    refreshNotifications().catch(() => {})
  } catch (e: any) {
    cards.value.splice(idx, 1, prev)
    toast.add({ title: 'Archive failed', description: e?.data?.statusMessage, color: 'error' })
  }
}

// Archiving from the edit panel persists the card's edits (labels, etc.) first,
// then moves it into the ARCHIVE column so the move endpoint logs the history.
async function onArchiveCard(patch: Partial<Card>) {
  const card = activeCard.value
  if (!card) return
  try {
    const saved = await persistCard(card, patch)
    const i = cards.value.findIndex(c => c.id === saved.id)
    if (i >= 0) cards.value.splice(i, 1, saved)
    cardPanelOpen.value = false
    await archiveCard(saved)
  } catch (e: any) {
    toast.add({ title: 'Archive failed', description: e?.data?.statusMessage, color: 'error' })
  }
}

// Header gear dropdown for the focused project — same actions as the
// project right-click menu.
const projectMenuItems = computed(() => {
  const p = selectedProject.value
  if (!p) return []
  return [
    [
      {
        label: 'Settings',
        icon: 'i-lucide-settings',
        onSelect: () => openRenameProject(p)
      },
      {
        label: 'Add swimlane',
        icon: 'i-lucide-plus',
        onSelect: () => openAddSwimlane(p.id)
      }
    ],
    [
      {
        label: 'Delete project',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => deleteProject(p)
      }
    ]
  ]
})

// --- Context menu ---
const ctxMenu = ref<{
  open: boolean
  x: number
  y: number
  items: Array<{ label: string; icon?: string; danger?: boolean; action: string }>
  target:
    | { kind: 'project'; project: Project }
    | { kind: 'column'; column: Column }
    | { kind: 'card'; card: Card }
    | null
}>({ open: false, x: 0, y: 0, items: [], target: null })

function openCardCtx(e: { card: Card; x: number; y: number }) {
  const isArchived = columns.value.find(c => c.id === e.card.column_id)?.name === 'ARCHIVE'
  ctxMenu.value = {
    open: true,
    x: e.x,
    y: e.y,
    target: { kind: 'card', card: e.card },
    items: [
      { label: 'Edit Card', icon: 'i-lucide-pencil', action: 'edit' },
      ...(isArchived ? [] : [{ label: 'Archive Card', icon: 'i-lucide-archive', action: 'archive' }]),
      { label: 'Delete Card', icon: 'i-lucide-trash-2', danger: true, action: 'delete' }
    ]
  }
}

function openProjectCtx(e: { x: number; y: number; project: Project }) {
  ctxMenu.value = {
    open: true,
    x: e.x,
    y: e.y,
    target: { kind: 'project', project: e.project },
    items: [
      { label: 'Settings', icon: 'i-lucide-settings', action: 'rename' },
      { label: 'Add swimlane', icon: 'i-lucide-plus', action: 'add-swimlane' },
      { label: 'Delete', icon: 'i-lucide-trash-2', danger: true, action: 'delete' }
    ]
  }
}

function openColumnCtx(e: { x: number; y: number; column: Column }) {
  const isProtected = ['FEEDBACK INBOX', 'DOING', 'DONE', 'ARCHIVE'].includes(e.column.name)
  ctxMenu.value = {
    open: true,
    x: e.x,
    y: e.y,
    target: { kind: 'column', column: e.column },
    items: [
      { label: 'Rename', icon: 'i-lucide-pencil', action: 'rename' },
      ...(isProtected ? [] : [{ label: 'Delete', icon: 'i-lucide-trash-2', danger: true, action: 'delete' }])
    ]
  }
}

function onCtxSelect(action: string) {
  const t = ctxMenu.value.target
  ctxMenu.value.open = false
  if (!t) return
  if (t.kind === 'card') {
    if (action === 'edit') openCard(t.card)
    else if (action === 'archive') archiveCard(t.card)
    else if (action === 'delete') onDeleteCard(t.card.id)
    return
  }
  if (t.kind === 'project') {
    if (action === 'rename') openRenameProject(t.project)
    else if (action === 'add-swimlane') openAddSwimlane(t.project.id)
    else if (action === 'delete') deleteProject(t.project)
  } else if (t.kind === 'column') {
    if (action === 'rename') {
      if (!import.meta.client) return
      const name = prompt('Column name', t.column.name)
      if (name) {
        $fetch(`/api/feedback/columns/${t.column.id}`, { method: 'PATCH', body: { name } })
          .then(() => loadAll())
          .catch((e: any) => toast.add({ title: 'Rename failed', description: e?.data?.statusMessage, color: 'error' }))
      }
    }
  }
}

async function onReorderColumn(payload: { draggedId: string; targetId: string }) {
  const prev = [...columns.value]
  const a = columns.value.findIndex(c => c.id === payload.draggedId)
  const b = columns.value.findIndex(c => c.id === payload.targetId)
  if (a < 0 || b < 0) return
  const [moved] = columns.value.splice(a, 1)
  columns.value.splice(b, 0, moved!)
  try {
    await $fetch('/api/feedback/columns/reorder', {
      method: 'PATCH',
      body: { draggedColumnId: payload.draggedId, targetColumnId: payload.targetId }
    })
    await loadAll()
  } catch (e: any) {
    columns.value = prev
    toast.add({ title: 'Reorder failed', description: e?.data?.statusMessage, color: 'error' })
  }
}

async function onToggleProjectExpand(project: Project) {
  const target = !((project as any).is_expanded === true)
  const i = projects.value.findIndex(p => p.id === project.id)
  if (i < 0) return
  projects.value.splice(i, 1, { ...(projects.value[i] as any), is_expanded: target })
  try {
    await $fetch(`/api/feedback/projects/${project.id}`, {
      method: 'PATCH',
      body: { is_expanded: target }
    })
  } catch (e: any) {
    projects.value.splice(i, 1, project)
    toast.add({ title: 'Toggle failed', description: e?.data?.statusMessage || 'Error', color: 'error' })
  }
}

async function onReorderProjects(payload: { orderedIds: string[] }) {
  const prev = [...projects.value]
  projects.value = payload.orderedIds
    .map(id => projects.value.find(p => p.id === id))
    .filter((p): p is Project => !!p)
  try {
    await $fetch('/api/feedback/projects/reorder', {
      method: 'POST',
      body: { orderedIds: payload.orderedIds }
    })
  } catch (e: any) {
    projects.value = prev
    toast.add({ title: 'Reorder failed', description: e?.data?.statusMessage, color: 'error' })
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] min-h-0 -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <ProjectsSidebar
      v-model:open="sidebarOpen"
      :projects="projects"
      :inbox-counts="inboxCounts"
      :selected-id="selectedProject?.id ?? null"
      @select="selectProject"
      @add-project="openCreateProject"
      @settings="openSettings"
    />

    <section class="flex-1 flex flex-col min-w-0 overflow-hidden border-l-0 lg:border-l border-(--ui-border)">
    <div class="shrink-0 bg-(--ui-bg-elevated) border-b border-(--ui-border) px-4 py-2 flex items-center gap-2">
      <UButton
        class="lg:hidden"
        icon="i-lucide-menu"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Open projects"
        @click="sidebarOpen = true"
      />
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <UIcon name="i-lucide-inbox" class="shrink-0" />
        <div class="min-w-0">
          <h1 class="font-semibold truncate text-sm sm:text-base">
            {{ selectedProject ? selectedProject.name : 'Feedback' }}
          </h1>
        </div>
      </div>

      <span
        v-if="zoomLevel !== 100"
        class="text-[11px] text-(--ui-text-muted) font-mono shrink-0 select-none"
        title="Ctrl+scroll to zoom"
      >{{ zoomLevel }}%</span>

      <div class="flex items-center gap-2 shrink-0">
        <UButton
          variant="ghost"
          size="sm"
          icon="i-lucide-refresh-ccw"
          aria-label="Reload"
          @click="loadAll"
        />
        <UDropdownMenu
          v-if="selectedProject"
          :items="projectMenuItems"
        >
          <UButton
            variant="ghost"
            size="sm"
            icon="i-lucide-settings"
            :aria-label="`${selectedProject.name} actions`"
          />
        </UDropdownMenu>
        <UButton
          variant="soft"
          size="sm"
          icon="i-lucide-plus"
          @click="openCreateProject"
        >
          New project
        </UButton>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex flex-col">
      <UAlert v-if="error" color="error" :title="error" class="m-4" />

      <div v-if="loading" class="py-12 text-center text-(--ui-text-muted)">
        Loading board…
      </div>

      <div v-else-if="projects.length === 0" class="py-12 text-center">
        <p class="text-(--ui-text-muted) mb-4">No projects yet.</p>
        <UButton icon="i-lucide-plus" @click="openCreateProject">Create your first project</UButton>
      </div>

      <div
        v-else
        class="flex-1 min-h-0 origin-top-left flex flex-col"
        :style="zoomLevel !== 100 ? { zoom: `${zoomLevel}%` } : {}"
      >
        <div
          v-if="zoomLevel === 100"
          class="absolute bottom-2 right-4 z-10 text-[11px] text-(--ui-text-muted) pointer-events-none select-none opacity-50"
        >
          Hold Ctrl + scroll to zoom
        </div>

        <ProjectsBoard
          :projects="visibleProjects"
          :columns="columns"
          :swimlanes="swimlanes"
          :cards="cards"
          :scope="scope"
          :fill-height="!!selectedProject"
          @add-card="openAddCard"
          @card-click="openCard"
          @card-context-menu="openCardCtx"
          @card-drop="onCardDrop"
          @add-swimlane="openAddSwimlane"
          @rename-project="openRenameProject"
          @reorder-column="onReorderColumn"
          @reorder-projects="onReorderProjects"
          @project-context-menu="openProjectCtx"
          @column-context-menu="openColumnCtx"
          @request-add-project="openCreateProject"
          @toggle-project-expand="onToggleProjectExpand"
        />
      </div>
    </div>
    </section>

    <CardEditSidePanel
      v-model="cardPanelOpen"
      :card="activeCard"
      :columns="columns"
      :projects="projects"
      :users="assignableUsers"
      @save="onSaveCard"
      @delete="onDeleteCard"
      @archive="onArchiveCard"
      @replied="onCardReplied"
    />

    <UModal v-model:open="projectModalOpen" :title="projectForm.mode === 'create' ? 'New project' : 'Project settings'">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name" required>
            <UInput v-model="projectForm.name" placeholder="e.g., Map A" autofocus class="w-full" />
          </UFormField>
          <UFormField label="Description">
            <UTextarea v-model="projectForm.description" :rows="2" class="w-full" />
          </UFormField>
          <UFormField
            v-if="projectForm.mode === 'edit'"
            label="Project key"
            help="Pass this value as the feedback web component's `projectId` prop when embedding the widget."
          >
            <UInput
              :model-value="projectForm.id"
              readonly
              class="w-full"
              @focus="$event.target.select()"
            >
              <template #trailing>
                <UButton
                  :icon="copiedProjectId === projectForm.id ? 'i-lucide-check' : 'i-lucide-copy'"
                  variant="link"
                  :color="copiedProjectId === projectForm.id ? 'success' : 'neutral'"
                  size="xs"
                  :aria-label="`Copy project ID for feedback web component (${projectForm.id})`"
                  :title="copiedProjectId === projectForm.id ? 'Copied!' : 'Copy project ID'"
                  @click="copyProjectId(projectForm.id)"
                />
              </template>
            </UInput>
          </UFormField>
          <UFormField
            v-if="projectForm.mode === 'edit'"
            label="Allowed widget origins"
            help="Sites where the embeddable feedback widget may sign users in (one origin per line, e.g. https://app.example.com). Leave empty to disable cross-origin sign-in."
          >
            <UTextarea
              v-model="projectForm.allowedOrigins"
              :rows="3"
              placeholder="https://app.example.com&#10;https://docs.example.com"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="projectForm.mode === 'edit'"
            label="Notify on new feedback"
            help="These users get the daily digest of new feedback for this project. Leave empty to fall back to the default recipients in Feedback settings."
          >
            <USelectMenu
              v-model="projectForm.notifyUserIds"
              :items="userItems"
              value-key="id"
              label-key="label"
              multiple
              :search-input="{ placeholder: 'Search users...' }"
              placeholder="Use default recipients"
              class="w-full"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex items-center gap-2">
          <UButton
            v-if="projectForm.mode === 'edit'"
            color="error"
            variant="soft"
            icon="i-lucide-trash-2"
            @click="deleteProjectFromModal"
          >
            Delete
          </UButton>
          <div class="ml-auto flex gap-2">
            <UButton variant="ghost" @click="projectModalOpen = false">Cancel</UButton>
            <UButton :loading="projectBusy" :disabled="!projectForm.name.trim()" @click="submitProject">
              {{ projectForm.mode === 'create' ? 'Create' : 'Save' }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="settingsModalOpen" title="Feedback settings">
      <template #body>
        <div class="space-y-4">
          <UFormField
            label="Default notification recipients"
            help="These users get the daily digest of new feedback for any project that hasn't chosen its own recipients. Leave empty to notify no one by default."
          >
            <USelectMenu
              v-model="defaultNotifyUserIds"
              :items="userItems"
              value-key="id"
              label-key="label"
              multiple
              :search-input="{ placeholder: 'Search users...' }"
              placeholder="No default recipients"
              class="w-full"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="settingsModalOpen = false">Cancel</UButton>
          <UButton :loading="settingsBusy" @click="saveSettings">Save</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="swimlaneModalOpen" title="New swimlane">
      <template #body>
        <UFormField label="Name" required>
          <UInput v-model="swimlaneForm.name" placeholder="e.g., Mobile view" autofocus />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="swimlaneModalOpen = false">Cancel</UButton>
          <UButton :loading="swimlaneBusy" :disabled="!swimlaneForm.name.trim()" @click="submitSwimlane">
            Create
          </UButton>
        </div>
      </template>
    </UModal>

    <KanbanContextMenu
      v-model:open="ctxMenu.open"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @select="onCtxSelect"
    />

    <UModal v-model:open="cardModalOpen" title="New card">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Title" required>
            <UInput v-model="cardForm.title" placeholder="Briefly describe the card" autofocus />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="cardModalOpen = false">Cancel</UButton>
          <UButton :loading="cardBusy" :disabled="!cardForm.title.trim()" @click="submitCard">
            Create
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
