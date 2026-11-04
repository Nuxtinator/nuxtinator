<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const key = computed(() => String(route.params.key ?? ''))

interface SectionData {
  portfolio_id: string
  key: string
  title: string
  description: string
  is_custom: boolean
  content: string
  last_edited_at: string | null
  last_edited_by_name: string | null
  index_state?: 'none' | 'ok' | 'stale' | 'unindexed'
  index_error?: string | null
  pending_suggestions: {
    total: number
    visible: Array<{ id: string, set_id: string, author_name: string | null, created_at: string }>
  }
}

const { data, refresh } = await useAsyncData(
  () => `context-section-${slug.value}-${key.value}`,
  () => $fetch<SectionData>(`/api/context/portfolios/${slug.value}/sections/${key.value}`)
)

const editing = ref(false)
const draft = ref(data.value?.content ?? '')
const saving = ref(false)
const removeOpen = ref(false)
const removing = ref(false)
const error = ref<string | null>(null)
const sidebarOpen = ref(false)
const { hasPermission } = usePermissions()
const canManageSections = computed(() => hasPermission('context.section.custom'))
const canReview = computed(() => hasPermission('context.suggestion.review'))

// One visible suggestion links straight to its set; several go to the queue.
const suggestionLink = computed(() => {
  const visible = data.value?.pending_suggestions.visible ?? []
  if (visible.length === 0) return null
  if (visible.length > 1) return '/context/suggestions'
  return { path: `/context/suggestions/${visible[0]!.set_id}`, query: { return: `/context/${slug.value}/sections/${key.value}` } }
})

watch(data, (next) => {
  if (next && !editing.value) draft.value = next.content
})

const wordCount = computed(() => {
  const t = (editing.value ? draft.value : data.value?.content ?? '').trim()
  return t ? t.split(/\s+/).length : 0
})

function startEdit() {
  draft.value = data.value?.content ?? ''
  editing.value = true
}

function cancelEdit() {
  draft.value = data.value?.content ?? ''
  editing.value = false
  error.value = null
}

async function removeSection() {
  removing.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${slug.value}/sections/${key.value}`, { method: 'DELETE' })
    removeOpen.value = false
    await refreshNuxtData([`context-sidebar-sections-${slug.value}`, `context-sections-${slug.value}`])
    await navigateTo(`/context/${slug.value}`)
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Remove failed.'
  } finally {
    removing.value = false
  }
}

// The search index is rebuilt on every save; a failed rebuild shows below
// with a button to retry without re-saving.
const reindexing = ref(false)
async function reindex() {
  reindexing.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${slug.value}/sections/${key.value}/reindex`, { method: 'POST' })
    await refresh()
  } catch (e) {
    error.value = (e as Error).message ?? 'Re-embed failed.'
  } finally {
    reindexing.value = false
  }
}

async function save() {
  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${slug.value}/sections/${key.value}`, {
      method: 'PUT',
      body: { content: draft.value }
    })
    await refresh()
    editing.value = false
  } catch (e) {
    error.value = (e as Error).message ?? 'Save failed.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <ContextSidebar v-model:open="sidebarOpen" />

    <section class="flex-1 flex flex-col min-w-0 border-l-0 lg:border-l border-(--ui-border) overflow-hidden">
      <header class="flex items-center gap-2 px-3 py-2 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open sidebar"
          @click="sidebarOpen = true"
        />
        <div class="flex-1 min-w-0">
          <h1 class="font-semibold truncate">
            {{ data?.title ?? key }}
          </h1>
          <p v-if="data?.description" class="text-xs text-(--ui-text-muted) truncate">
            {{ data.description }}
          </p>
        </div>
        <UButton variant="outline" icon="i-lucide-history" size="sm" :to="`/context/${slug}/sections/${key}/versions`">
          History
        </UButton>
        <UButton
          v-if="canManageSections && !editing"
          variant="outline"
          color="error"
          icon="i-lucide-trash"
          size="sm"
          aria-label="Remove section"
          @click="removeOpen = true"
        />
        <template v-if="editing">
          <UButton variant="ghost" size="sm" @click="cancelEdit">
            Cancel
          </UButton>
          <UButton color="primary" size="sm" :loading="saving" @click="save">
            Save
          </UButton>
        </template>
        <UButton v-else color="primary" variant="outline" icon="i-lucide-pencil" size="sm" @click="startEdit">
          Edit
        </UButton>
      </header>

      <div
        v-if="data?.pending_suggestions.total"
        class="flex items-center gap-2 px-3 py-2 border-b border-(--ui-border) bg-(--ui-warning)/10 text-sm"
      >
        <UIcon name="i-lucide-git-pull-request-arrow" class="size-4 shrink-0 text-(--ui-warning)" />
        <span class="flex-1">
          {{ data.pending_suggestions.total === 1
            ? 'A suggested update to this section is waiting for review.'
            : `${data.pending_suggestions.total} suggested updates to this section are waiting for review.` }}
        </span>
        <UButton v-if="suggestionLink" size="xs" variant="outline" :to="suggestionLink">
          {{ canReview ? 'Review' : 'View' }}
        </UButton>
      </div>

      <ContextMarkdownToolbar v-if="editing" :textarea-id="`section-editor-${key}`" />

      <UAlert
        v-if="data?.index_state === 'stale' && !editing"
        class="mx-3 mt-3"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Search index didn't regenerate"
        :description="`The assistant's search still sees the previous version of this section. ${data.index_error ?? ''}`"
      >
        <template #actions>
          <UButton size="xs" color="warning" variant="solid" icon="i-lucide-refresh-cw" :loading="reindexing" @click="reindex">
            Re-embed
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="data?.index_state === 'unindexed' && !editing"
        class="mx-3 mt-3"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        title="Not in the search index yet"
        description="This section was written before search indexing was set up, so the assistant's search can't find it."
      >
        <template #actions>
          <UButton size="xs" color="info" variant="solid" icon="i-lucide-refresh-cw" :loading="reindexing" @click="reindex">
            Index now
          </UButton>
        </template>
      </UAlert>

      <div class="flex-1 flex min-h-0">
        <div class="flex-1 flex min-h-0 overflow-auto">
          <textarea
            v-if="editing"
            :id="`section-editor-${key}`"
            v-model="draft"
            class="flex-1 w-full h-full p-6 font-mono text-sm outline-none bg-(--ui-bg) resize-none"
            placeholder="Start writing in markdown…"
          />
          <div v-else class="flex-1 p-6 overflow-auto">
            <div v-if="!data?.content" class="text-(--ui-text-muted) text-sm italic">
              This section is empty. Click <strong>Edit</strong> to add content.
            </div>
            <ContextSectionPreview v-else :content="data.content" />
          </div>
        </div>
      </div>

      <footer class="flex items-center gap-3 px-3 py-1.5 border-t border-(--ui-border) bg-(--ui-bg) text-xs text-(--ui-text-muted)">
        <span>{{ wordCount }} words</span>
        <span v-if="data?.last_edited_at">
          · last edited {{ new Date(data.last_edited_at).toLocaleString() }}
          <span v-if="data.last_edited_by_name"> by {{ data.last_edited_by_name }}</span>
        </span>
        <span class="flex-1" />
        <span v-if="error" class="text-(--ui-error)">{{ error }}</span>
      </footer>
    </section>

    <ContextConfirmModal
      v-model:open="removeOpen"
      :title="`Remove ${data?.title ?? key}?`"
      description="Its content is kept and comes back if you add the section again."
      confirm-label="Remove"
      :loading="removing"
      @confirm="removeSection"
    />
  </div>
</template>
