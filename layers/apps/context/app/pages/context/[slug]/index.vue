<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const sidebarOpen = ref(false)

interface PortfolioRow {
  id: string
  slug: string
  name: string
  color: string | null
  icon_url: string | null
}

interface SectionMeta {
  key: string
  title: string
  description: string
  order: number
  is_custom: boolean
  id: string
  word_count: number
  has_content: boolean
  last_edited_at: string | null
  last_edited_by_name: string | null
}

const { data: portfolio } = await useAsyncData(
  () => `context-portfolio-${slug.value}`,
  () => $fetch<PortfolioRow>(`/api/context/portfolios/${slug.value}`)
)
const { data: sectionsData, refresh } = await useAsyncData(
  () => `context-sections-${slug.value}`,
  () => $fetch<{ portfolio_id: string, sections: SectionMeta[] }>(`/api/context/portfolios/${slug.value}/sections`)
)
const sections = computed(() => sectionsData.value?.sections ?? [])
const completedCount = computed(() => sections.value.filter(s => s.has_content && s.word_count >= 50).length)

// Fetched through `$fetch` rather than linked, because a plain navigation
// doesn't carry the X-Active-Org header the export endpoint needs.
const toast = useToast()
const exporting = ref(false)
async function exportPortfolio() {
  exporting.value = true
  try {
    const res = await $fetch.raw<Blob>(`/api/context/portfolios/${slug.value}/export`, { responseType: 'blob' })
    const disposition = res.headers.get('content-disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${slug.value}.zip`
    const url = URL.createObjectURL(res._data!)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    toast.add({ title: (e as { statusMessage?: string }).statusMessage ?? 'Export failed.', color: 'error' })
  } finally {
    exporting.value = false
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
            {{ portfolio?.name }}
          </h1>
          <p class="text-xs text-(--ui-text-muted)">
            {{ completedCount }} of {{ sections.length }} sections complete
          </p>
        </div>
        <UButton variant="outline" icon="i-lucide-download" size="sm" :loading="exporting" @click="exportPortfolio">
          Export
        </UButton>
        <UButton variant="outline" icon="i-lucide-settings" size="sm" :to="`/context/${slug}/settings`">
          Settings
        </UButton>
      </header>

      <div class="flex-1 overflow-auto p-6">
        <div class="max-w-3xl mx-auto space-y-3">
          <NuxtLink
            v-for="(s, idx) in sections"
            :key="s.key"
            :to="`/context/${slug}/sections/${s.key}`"
            class="block border border-(--ui-border) rounded-lg px-5 py-4 transition hover:border-(--ui-primary)"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-3">
                  <span class="font-mono text-xs text-(--ui-text-muted) shrink-0">
                    {{ String(idx + 1).padStart(2, '0') }}
                  </span>
                  <h3 class="font-medium">
                    {{ s.title }}
                  </h3>
                  <ContextSectionStatusBadge :section="s" />
                </div>
                <p class="text-sm text-(--ui-text-muted) mt-1">
                  {{ s.description }}
                </p>
              </div>
              <div class="text-xs text-(--ui-text-muted) shrink-0 text-right">
                <div v-if="s.has_content">
                  {{ s.word_count }} words
                </div>
                <div v-if="s.last_edited_at">
                  {{ new Date(s.last_edited_at).toLocaleDateString() }}
                </div>
              </div>
            </div>
          </NuxtLink>
          <ContextSectionsManager :slug="slug" :list="false" class="pt-4" @changed="refresh" />
        </div>
      </div>
    </section>
  </div>
</template>
