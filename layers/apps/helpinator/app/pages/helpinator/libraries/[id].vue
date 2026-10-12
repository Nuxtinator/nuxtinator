<script setup lang="ts">
// Create / edit one library. A website library lists its URL entries with
// crawl status, per-entry re-crawl and a "sync all"; a portfolio library just
// points at a portfolio. Pages are read-only here (corrections belong in a
// portfolio-backed library).
import type {
  HelpinatorLibraryDetail,
  HelpinatorLibrary,
  HelpinatorSource,
  HelpinatorPageSummary,
  HelpinatorPortfolioOption
} from '../../../utils/helpinator-types'
import { helpinatorErrorMessage, helpinatorFormatBytes } from '../../../utils/helpinator-types'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const pathTo = useHelpinatorPath()
const toast = useToast()
const isNew = computed(() => route.params.id === 'new')
const { data: status } = useHelpinatorStatus()
const { data: portfolios } = useFetch<HelpinatorPortfolioOption[]>('/api/helpinator/portfolios', { default: () => [] })

const form = reactive({
  name: '',
  kind: 'website' as 'website' | 'portfolio',
  portfolio_id: '' as string,
  description: ''
})
const saved = ref<HelpinatorLibraryDetail | null>(null)
const saving = ref(false)
const confirmDelete = ref(false)

function fill(l: HelpinatorLibraryDetail) {
  saved.value = l
  form.name = l.name
  form.kind = l.kind
  form.portfolio_id = l.portfolio_id ?? ''
  form.description = l.description
}

async function load() {
  const l = await $fetch<HelpinatorLibraryDetail>(`/api/helpinator/libraries/${route.params.id}`)
  fill(l)
}

if (!isNew.value) {
  try {
    await load()
  } catch (err) {
    throw createError({ statusCode: (err as { statusCode?: number }).statusCode ?? 404, statusMessage: 'Library not found', fatal: true })
  }
}

const kindItems = [
  { label: 'Website — crawl a list of URLs', value: 'website' },
  { label: 'Portfolio — a context portfolio your team writes', value: 'portfolio' }
]
const portfolioItems = computed(() => (portfolios.value ?? []).map((p: HelpinatorPortfolioOption) => ({ label: p.name, value: p.id })))

async function save() {
  saving.value = true
  try {
    const body = {
      name: form.name,
      kind: form.kind,
      portfolio_id: form.kind === 'portfolio' ? form.portfolio_id || null : null,
      description: form.description
    }
    const l = isNew.value
      ? await $fetch<HelpinatorLibrary>('/api/helpinator/libraries', { method: 'POST', body })
      : await $fetch<HelpinatorLibrary>(`/api/helpinator/libraries/${saved.value!.id}`, { method: 'PUT', body })
    toast.add({ title: 'Library saved', color: 'success' })
    refreshNuxtData('helpinator-sidebar-libraries') // names show in the sidebar
    if (isNew.value) await navigateTo(pathTo(`/helpinator/libraries/${l.id}`), { replace: true })
    else await load()
  } catch (err) {
    toast.add({ title: 'Could not save', description: helpinatorErrorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function remove() {
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}`, { method: 'DELETE' })
    refreshNuxtData('helpinator-sidebar-libraries')
    await navigateTo(pathTo('/helpinator/libraries'))
  } catch (err) {
    confirmDelete.value = false
    toast.add({ title: 'Could not delete', description: helpinatorErrorMessage(err), color: 'error' })
  }
}

// ---- URL entries ----------------------------------------------------------

const newSource = reactive({ url: '', restrict_to_path: true, max_pages: 200, max_page_mb: 2 })
const adding = ref(false)

const syncing = computed(() => (saved.value?.sources ?? []).some(s => s.status === 'syncing'))
let pollTimer: ReturnType<typeof setTimeout> | null = null
async function poll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  try {
    await load()
  } catch {
    return
  }
  if (syncing.value) pollTimer = setTimeout(poll, 3000)
}
watch(syncing, (on) => {
  if (on && !pollTimer) pollTimer = setTimeout(poll, 3000)
}, { immediate: true })
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

async function addSource() {
  adding.value = true
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}/sources`, { method: 'POST', body: { ...newSource, max_pages: Number(newSource.max_pages), max_page_mb: Number(newSource.max_page_mb) } })
    newSource.url = ''
    toast.add({ title: 'Crawling…', description: 'The pages appear here as they are fetched.', color: 'success' })
    await poll()
  } catch (err) {
    toast.add({ title: 'Could not add the URL', description: helpinatorErrorMessage(err), color: 'error' })
  } finally {
    adding.value = false
  }
}

async function resync(s: HelpinatorSource) {
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}/sources/${s.id}/sync`, { method: 'POST' })
    await poll()
  } catch (err) {
    toast.add({ title: 'Could not start the crawl', description: helpinatorErrorMessage(err), color: 'error' })
  }
}

async function syncAll() {
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}/sync`, { method: 'POST' })
    await poll()
  } catch (err) {
    toast.add({ title: 'Could not start the crawl', description: helpinatorErrorMessage(err), color: 'error' })
  }
}

// Edit an entry's crawl settings; they apply from its next crawl.
const editingSource = ref<HelpinatorSource | null>(null)
const editForm = reactive({ restrict_to_path: true, max_pages: 200, max_page_mb: 2 })
const savingSource = ref(false)
function editSource(s: HelpinatorSource) {
  Object.assign(editForm, { restrict_to_path: s.restrict_to_path, max_pages: s.max_pages, max_page_mb: s.max_page_mb })
  editingSource.value = s
}
async function saveSource() {
  savingSource.value = true
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}/sources/${editingSource.value!.id}`, {
      method: 'PUT',
      body: { restrict_to_path: editForm.restrict_to_path, max_pages: Number(editForm.max_pages), max_page_mb: Number(editForm.max_page_mb) }
    })
    editingSource.value = null
    toast.add({ title: 'Saved', description: 'The new settings apply from the next crawl.', color: 'success' })
    await load()
  } catch (err) {
    toast.add({ title: 'Could not save', description: helpinatorErrorMessage(err), color: 'error' })
  } finally {
    savingSource.value = false
  }
}

const removingSource = ref<HelpinatorSource | null>(null)
async function removeSource() {
  const s = removingSource.value!
  try {
    await $fetch(`/api/helpinator/libraries/${saved.value!.id}/sources/${s.id}`, { method: 'DELETE' })
    removingSource.value = null
    await load()
  } catch (err) {
    toast.add({ title: 'Could not remove', description: helpinatorErrorMessage(err), color: 'error' })
  }
}

function statusColor(s: HelpinatorSource): 'success' | 'error' | 'info' | 'neutral' {
  if (s.status === 'done') return s.last_error ? 'error' : 'success'
  if (s.status === 'error') return 'error'
  if (s.status === 'syncing') return 'info'
  return 'neutral'
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'
}

// ---- Pages drawer ---------------------------------------------------------

const pagesOpen = ref(false)
const pagesSource = ref<HelpinatorSource | null>(null)
const pages = ref<HelpinatorPageSummary[]>([])
const pagesLoading = ref(false)
const pagesHasMore = ref(false)
const pageView = ref<{ title: string, url: string, content: string } | null>(null)

async function showPages(s: HelpinatorSource) {
  pagesSource.value = s
  pagesOpen.value = true
  pageView.value = null
  pages.value = []
  pagesLoading.value = true
  try {
    await loadMorePages()
  } finally {
    pagesLoading.value = false
  }
}

async function loadMorePages() {
  const res = await $fetch<{ pages: HelpinatorPageSummary[], hasMore: boolean }>(`/api/helpinator/libraries/${saved.value!.id}/pages`, {
    query: { source: pagesSource.value!.id, offset: pages.value.length }
  })
  pages.value = [...pages.value, ...res.pages]
  pagesHasMore.value = res.hasMore
}

async function viewPage(p: HelpinatorPageSummary) {
  pageView.value = await $fetch(`/api/helpinator/libraries/${saved.value!.id}/pages/${p.id}`)
}

async function prunePage(p: HelpinatorPageSummary) {
  await $fetch(`/api/helpinator/libraries/${saved.value!.id}/pages/${p.id}`, { method: 'DELETE' })
  pages.value = pages.value.filter(x => x.id !== p.id)
  await load()
}
</script>

<template>
  <HelpinatorShell :title="isNew ? 'New library' : form.name || 'Library'">
    <div class="max-w-5xl mx-auto space-y-6">
      <UButton :to="pathTo('/helpinator/libraries')" icon="i-lucide-arrow-left" variant="ghost" color="neutral" size="sm">
        All libraries
      </UButton>

      <UAlert v-if="status && !status.canManage" color="warning" variant="subtle" title="You don't have permission to manage libraries." />

      <form v-else class="space-y-4" @submit.prevent="save">
        <UCard>
          <template #header>
            <h2 class="font-semibold">
              Library
            </h2>
          </template>
          <div class="space-y-4">
            <UFormField label="Name" required>
              <UInput v-model="form.name" class="w-full" />
            </UFormField>
            <UFormField label="Kind" :help="isNew ? '' : 'Fixed after creation.'" required>
              <USelect v-model="form.kind" :items="kindItems" :disabled="!isNew" class="w-full" />
            </UFormField>
            <UFormField
              v-if="form.kind === 'portfolio'"
              label="Portfolio"
              help="Treat everything in it as public — visitors can get the assistant to reveal any of it. This is also where corrections to crawled content belong."
              required
            >
              <USelect v-model="form.portfolio_id" :items="portfolioItems" placeholder="Choose a portfolio" class="w-full" />
            </UFormField>
            <UFormField label="Description" help="For your own reference.">
              <UInput v-model="form.description" class="w-full" :maxlength="2000" />
            </UFormField>
          </div>
        </UCard>
        <div class="flex items-center gap-2">
          <UButton type="submit" :loading="saving">
            {{ isNew ? 'Create library' : 'Save' }}
          </UButton>
          <div class="flex-1" />
          <UButton v-if="!isNew" color="error" variant="ghost" icon="i-lucide-trash-2" @click="confirmDelete = true">
            Delete
          </UButton>
        </div>
      </form>

      <UCard v-if="saved && saved.kind === 'website'">
        <template #header>
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="font-semibold flex-1">
              URLs
            </h2>
            <span class="text-xs text-(--ui-text-muted)">
              {{ saved.stats.pages }} pages · {{ helpinatorFormatBytes(saved.stats.bytes) }} · {{ saved.stats.chunks }} chunks
            </span>
            <UButton size="xs" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :disabled="!saved.sources.length || syncing" @click="syncAll">
              Sync all
            </UButton>
          </div>
        </template>

        <div class="space-y-4">
          <UAlert
            v-if="saved.index_stale"
            color="warning"
            variant="subtle"
            icon="i-lucide-database-zap"
            title="The search index was built with another embedding model"
            description="Search returns nothing useful until it is rebuilt. Use the re-embed button on the AI settings page."
          />
          <UAlert
            v-if="!saved.embedding_model"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="No embedding model is set"
            description="Pages are crawled but cannot be indexed for search until an embedding model is chosen on the AI settings page."
          />

          <p v-if="saved.sources.length === 0" class="text-sm text-(--ui-text-muted)">
            No URLs yet. Each entry crawls its page plus the same-site pages it links to.
          </p>

          <ul v-else class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-lg">
            <li v-for="s in saved.sources" :key="s.id" class="px-4 py-3 space-y-1">
              <div class="flex items-center gap-3">
                <UIcon name="i-lucide-globe" class="size-4 shrink-0 text-(--ui-text-muted)" />
                <div class="flex-1 min-w-0">
                  <p class="truncate">
                    <a :href="s.url" target="_blank" rel="noopener" class="hover:underline">{{ s.url }}</a>
                    <span class="text-(--ui-text-muted)"> ({{ s.page_count }} pages)</span>
                    <span v-if="s.status === 'syncing'" class="text-(--ui-text-muted) text-sm">
                      · {{ s.run_total ? `crawling ${s.run_done} of ${s.run_total}` : 'finding pages…' }}
                    </span>
                  </p>
                  <p class="text-xs text-(--ui-text-muted) flex items-center gap-2 flex-wrap">
                    <span>{{ s.restrict_to_path ? 'Under this path' : 'Whole site, one hop' }}</span>
                    <span>·</span>
                    <span>max {{ s.max_pages }}</span>
                    <span>·</span>
                    <span>{{ s.max_page_mb }} MB/page</span>
                    <span>·</span>
                    <span>{{ when(s.last_synced_at) }}</span>
                    <span>·</span>
                    <span>{{ helpinatorFormatBytes(s.bytes) }}</span>
                    <UBadge :color="statusColor(s)" variant="subtle" size="sm">
                      <UIcon v-if="s.status === 'syncing'" name="i-lucide-loader-circle" class="size-3 animate-spin mr-1" />
                      {{ s.status === 'done' && s.last_error ? 'done with errors' : s.status }}
                    </UBadge>
                  </p>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <UButton size="xs" variant="ghost" color="neutral" :disabled="!s.page_count" @click="showPages(s)">
                    View
                  </UButton>
                  <UButton size="xs" variant="ghost" color="neutral" @click="editSource(s)">
                    Edit
                  </UButton>
                  <UButton size="xs" variant="ghost" color="primary" @click="resync(s)">
                    Re-crawl
                  </UButton>
                  <UButton size="xs" variant="ghost" color="error" @click="removingSource = s">
                    Remove
                  </UButton>
                </div>
              </div>
              <p v-if="s.last_error" class="text-xs text-(--ui-error) pl-7">
                {{ s.last_error }}
              </p>
            </li>
          </ul>

          <form class="flex flex-wrap items-end gap-2" @submit.prevent="addSource">
            <UFormField label="Add a URL" class="flex-1 min-w-64">
              <UInput v-model="newSource.url" placeholder="https://example.org/docs" class="w-full" />
            </UFormField>
            <UFormField label="Max pages">
              <UInput v-model.number="newSource.max_pages" type="number" :min="1" :max="1000" class="w-28" />
            </UFormField>
            <UFormField label="Max page size (MB)">
              <UInput v-model.number="newSource.max_page_mb" type="number" :min="1" :max="10" class="w-28" />
            </UFormField>
            <UCheckbox v-model="newSource.restrict_to_path" label="Only pages under this path" class="pb-2" />
            <UButton type="submit" icon="i-lucide-plus" :loading="adding" :disabled="!newSource.url.trim()">
              Add and crawl
            </UButton>
          </form>
          <p class="text-xs text-(--ui-text-muted)">
            The entry's page and every same-site page it links to are fetched (one hop), read with a
            readability extractor, and indexed for search. Pages are read-only: to correct or add to what
            a site says, put it in a portfolio library the widget also uses.
          </p>
        </div>
      </UCard>

      <UModal v-model:open="confirmDelete" title="Delete this library?">
        <template #body>
          <p class="text-sm">
            Its crawled pages and index are deleted. This is refused while a widget still lists the library.
          </p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton variant="ghost" color="neutral" @click="confirmDelete = false">
              Cancel
            </UButton>
            <UButton color="error" @click="remove">
              Delete library
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal :open="editingSource !== null" title="Edit URL entry" :description="editingSource?.url" @update:open="(v: boolean) => { if (!v) editingSource = null }">
        <template #body>
          <form id="edit-source" class="space-y-4" @submit.prevent="saveSource">
            <UFormField label="Max pages">
              <UInput v-model.number="editForm.max_pages" type="number" :min="1" :max="1000" class="w-28" />
            </UFormField>
            <UFormField label="Max page size (MB)" help="Pages over this are skipped and their last copy kept. Raise it for very large pages (up to 10 MB).">
              <UInput v-model.number="editForm.max_page_mb" type="number" :min="1" :max="10" class="w-28" />
            </UFormField>
            <UCheckbox v-model="editForm.restrict_to_path" label="Only pages under this path" />
          </form>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton variant="ghost" color="neutral" @click="editingSource = null">
              Cancel
            </UButton>
            <UButton type="submit" form="edit-source" :loading="savingSource">
              Save
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal :open="removingSource !== null" title="Remove this URL?" @update:open="(v: boolean) => { if (!v) removingSource = null }">
        <template #body>
          <p class="text-sm">
            The pages it crawled ({{ removingSource?.page_count ?? 0 }}) leave the library and its search index.
          </p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton variant="ghost" color="neutral" @click="removingSource = null">
              Cancel
            </UButton>
            <UButton color="error" @click="removeSource">
              Remove
            </UButton>
          </div>
        </template>
      </UModal>

      <USlideover v-model:open="pagesOpen" :title="pageView ? pageView.title : `Pages from ${pagesSource?.url ?? ''}`" :ui="{ content: 'max-w-2xl' }">
        <template #body>
          <div v-if="pageView" class="space-y-3">
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-left" @click="pageView = null">
              Back to the list
            </UButton>
            <a :href="pageView.url" target="_blank" rel="noopener" class="text-xs text-(--ui-primary) underline break-all">{{ pageView.url }}</a>
            <HelpinatorMarkdown :text="pageView.content" class="text-sm" />
          </div>
          <div v-else-if="pagesLoading" class="text-sm text-(--ui-text-muted)">
            Loading…
          </div>
          <ul v-else class="divide-y divide-(--ui-border)">
            <li v-for="p in pages" :key="p.id" class="py-2 flex items-center gap-2">
              <div class="flex-1 min-w-0">
                <button type="button" class="text-sm font-medium truncate block w-full text-left hover:underline" @click="viewPage(p)">
                  {{ p.title || p.url }}
                </button>
                <p class="text-xs text-(--ui-text-muted) truncate">
                  {{ p.url }} · {{ helpinatorFormatBytes(p.bytes) }}
                </p>
              </div>
              <UButton size="xs" variant="ghost" color="error" icon="i-lucide-x" aria-label="Remove page" @click="prunePage(p)" />
            </li>
            <li v-if="pages.length === 0" class="py-2 text-sm text-(--ui-text-muted)">
              No pages.
            </li>
            <li v-if="pagesHasMore" class="py-2">
              <UButton size="xs" variant="ghost" color="neutral" @click="loadMorePages">
                Load more
              </UButton>
            </li>
          </ul>
        </template>
      </USlideover>
    </div>
  </HelpinatorShell>
</template>
