<script setup lang="ts">
import type { ListContact, ListProgress, FaithStatus } from '../../utils/list-of-100-types'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const router = useRouter()
const confirmAction = useConfirm()

const contacts = ref<ListContact[]>([])
const progress = ref<ListProgress>({ total: 0, contactedLast30d: 0, prayedLast30d: 0 })
const loading = ref(true)
const search = ref('')
type ViewMode = 'table' | 'kanban' | 'relationships' | 'insights'
const view = computed<ViewMode>(() => {
  if (route.query.view === 'kanban') return 'kanban'
  if (route.query.view === 'relationships') return 'relationships'
  if (route.query.view === 'insights') return 'insights'
  return 'table'
})
function setView(v: ViewMode) {
  router.replace({ query: { ...route.query, view: v } })
}

const modalOpen = ref(false)
const editing = ref<ListContact | null>(null)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return contacts.value
  return contacts.value.filter(c =>
    c.name.toLowerCase().includes(q)
    || (c.notes ?? '').toLowerCase().includes(q)
    || c.relationship.toLowerCase().includes(q)
  )
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ contacts: ListContact[], progress: ListProgress }>(
      '/api/list-of-100/contacts'
    )
    contacts.value = res.contacts
    progress.value = res.progress
  } finally {
    loading.value = false
  }
}

function applyContact(updated: ListContact) {
  const idx = contacts.value.findIndex(c => c.id === updated.id)
  if (idx === -1) contacts.value.push(updated)
  else contacts.value[idx] = updated
}

function removeContact(id: string) {
  contacts.value = contacts.value.filter(c => c.id !== id)
}

function openCreate() {
  editing.value = null
  modalOpen.value = true
}
function openEdit(contact: ListContact) {
  editing.value = contact
  modalOpen.value = true
}

async function onSaved(contact: ListContact) {
  applyContact(contact)
  // Refresh progress aggregates after add/edit (faith status may have changed
  // a count, etc).
  await refreshProgress()
}

async function refreshProgress() {
  try {
    progress.value = await $fetch<ListProgress>('/api/list-of-100/progress')
  } catch { /* non-fatal */ }
}

async function markContacted(id: string) {
  const res = await $fetch<{ contact: ListContact }>(`/api/list-of-100/contacts/${id}/mark-contacted`, {
    method: 'POST'
  })
  applyContact(res.contact)
  await refreshProgress()
}

async function markPrayed(id: string) {
  const res = await $fetch<{ contact: ListContact }>(`/api/list-of-100/contacts/${id}/mark-prayed`, {
    method: 'POST'
  })
  applyContact(res.contact)
  await refreshProgress()
}

async function changeFaith(id: string, faith: FaithStatus) {
  const previous = contacts.value.find(c => c.id === id)
  if (!previous) return
  // Optimistic update — drag-drop should feel instant.
  applyContact({ ...previous, faith_status: faith })
  try {
    const res = await $fetch<{ contact: ListContact }>(`/api/list-of-100/contacts/${id}`, {
      method: 'PATCH',
      body: { faith_status: faith }
    })
    applyContact(res.contact)
  } catch (e) {
    // Roll back on failure.
    applyContact(previous)
    throw e
  }
}

async function deleteContact(contact: ListContact) {
  if (!await confirmAction({ title: `Remove ${contact.name} from your list?`, confirmLabel: 'Remove' })) return
  await $fetch(`/api/list-of-100/contacts/${contact.id}`, { method: 'DELETE' })
  removeContact(contact.id)
  await refreshProgress()
}

const tabItems = [
  { label: 'List', value: 'table' as const, icon: 'i-lucide-list' },
  { label: 'Status', value: 'kanban' as const, icon: 'i-lucide-columns-3' },
  { label: 'Relationship', value: 'relationships' as const, icon: 'i-lucide-users' },
  { label: 'Insights', value: 'insights' as const, icon: 'i-lucide-bar-chart-3' }
]
const viewModel = computed({
  get: () => view.value,
  set: (v: ViewMode) => setView(v)
})

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">
          List of 100
        </h1>
        <p class="text-sm text-(--ui-text-muted) mt-1">
          Steward the relationships God has put in your life.
        </p>
      </div>
      <UButton icon="i-lucide-plus" color="primary" @click="openCreate">
        Add contact
      </UButton>
    </div>

    <ListOf100ProgressHeader :progress="progress" />

    <div class="flex items-center justify-between gap-3 flex-wrap">
      <UTabs
        v-model="viewModel"
        :items="tabItems"
        :content="false"
        size="sm"
        color="primary"
      />
      <UInput
        v-if="view !== 'insights'"
        v-model="search"
        placeholder="Search contacts…"
        icon="i-lucide-search"
        size="sm"
        class="w-64 max-w-full"
      />
    </div>

    <div v-if="loading" class="py-12 text-center text-(--ui-text-muted)">
      Loading…
    </div>
    <template v-else>
      <ListOf100ContactTable
        v-if="view === 'table'"
        :contacts="filtered"
        @edit="openEdit"
        @delete="deleteContact"
        @mark-contacted="markContacted"
        @mark-prayed="markPrayed"
      />
      <ListOf100ContactKanban
        v-else-if="view === 'kanban'"
        :contacts="filtered"
        @edit="openEdit"
        @delete="deleteContact"
        @mark-contacted="markContacted"
        @mark-prayed="markPrayed"
        @change-faith="changeFaith"
      />
      <ListOf100ContactRelationships
        v-else-if="view === 'relationships'"
        :contacts="filtered"
        @edit="openEdit"
        @delete="deleteContact"
        @mark-contacted="markContacted"
        @mark-prayed="markPrayed"
      />
      <ListOf100ContactInsights v-else />
    </template>

    <ListOf100ContactFormModal
      v-model:open="modalOpen"
      :contact="editing"
      @saved="onSaved"
    />
  </div>
</template>
