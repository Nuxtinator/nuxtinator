<script setup lang="ts">
defineEmits<{ navigated: [], create: [] }>()

interface PortfolioListItem {
  id: string
  slug: string
  name: string
  color: string | null
  icon_url: string | null
}

interface SectionMeta {
  key: string
  title: string
  order: number
  is_custom: boolean
  word_count: number
  has_content: boolean
  pending_suggestions: number
}

const route = useRoute()
const activeSlug = computed(() => {
  const raw = route.params.slug
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.length > 0) return raw[0]!
  return null
})
const activeKey = computed(() => {
  const raw = route.params.key
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.length > 0) return raw[0]!
  return null
})

function pathTo(p: string): string {
  const org = route.params.orgSlug as string | undefined
  return org ? `/@${org}${p}` : p
}

const { data: portfoliosData } = await useAsyncData(
  'context-sidebar-portfolios',
  () => $fetch<{ portfolios: PortfolioListItem[] }>('/api/context/portfolios')
)
const portfolios = computed(() => portfoliosData.value?.portfolios ?? [])

const { data: sectionsData } = await useAsyncData(
  () => `context-sidebar-sections-${activeSlug.value ?? ''}`,
  () => activeSlug.value
    ? $fetch<{ portfolio_id: string, sections: SectionMeta[] }>(`/api/context/portfolios/${activeSlug.value}/sections`)
    : Promise.resolve({ portfolio_id: '', sections: [] }),
  { watch: [activeSlug] }
)
const sections = computed(() => sectionsData.value?.sections ?? [])
</script>

<template>
  <div class="flex flex-col gap-2" @click="$emit('navigated')">
    <div class="flex items-center justify-between px-1 mb-1">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted)">
        Portfolios
      </h3>
      <UButton
        icon="i-lucide-plus"
        variant="ghost"
        color="neutral"
        size="xs"
        aria-label="New portfolio"
        @click.stop="$emit('create')"
      />
    </div>

    <p v-if="portfolios.length === 0" class="px-2 py-2 text-xs text-(--ui-text-muted)">
      No portfolios yet.
    </p>

    <nav class="flex flex-col gap-px">
      <template v-for="p in portfolios" :key="p.id">
        <NuxtLink
          :to="pathTo(`/context/${p.slug}`)"
          class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
          :class="activeSlug === p.slug
            ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
            : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
        >
          <span class="shrink-0 w-4 h-4 flex items-center justify-center">
            <img
              v-if="p.icon_url"
              :src="p.icon_url"
              :alt="''"
              class="w-4 h-4 rounded-full object-cover"
            >
            <UIcon
              v-else
              name="i-lucide-book-open-text"
              class="size-4"
              :style="p.color ? { color: p.color } : undefined"
            />
          </span>
          <span class="truncate flex-1">{{ p.name }}</span>
        </NuxtLink>

        <nav
          v-if="activeSlug === p.slug"
          class="ml-5 border-l border-(--ui-border) pl-2 my-1 flex flex-col gap-px"
        >
          <NuxtLink
            v-for="(s, idx) in sections"
            :key="s.key"
            :to="pathTo(`/context/${p.slug}/sections/${s.key}`)"
            class="flex items-center gap-2 px-2 py-1 rounded-md text-xs transition"
            :class="activeKey === s.key
              ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
              : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
          >
            <span
              class="w-1.5 h-1.5 rounded-full border shrink-0"
              :class="s.has_content && s.word_count >= 50
                ? 'border-(--ui-success) bg-(--ui-success)'
                : 'border-(--ui-warning) bg-transparent'"
            />
            <span class="font-mono shrink-0 text-(--ui-text-muted)" style="font-size: 10px">
              {{ String(idx + 1).padStart(2, '0') }}
            </span>
            <span class="truncate flex-1">{{ s.title }}</span>
            <UIcon
              v-if="s.pending_suggestions > 0"
              name="i-lucide-git-pull-request-arrow"
              class="size-3 shrink-0 text-(--ui-warning)"
              :title="`${s.pending_suggestions} pending suggestion(s)`"
            />
          </NuxtLink>
          <NuxtLink
            :to="pathTo(`/context/${p.slug}/settings`)"
            class="flex items-center gap-2 px-2 py-1 rounded-md text-xs text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text) mt-1"
          >
            <UIcon name="i-lucide-settings" class="size-3 shrink-0" />
            <span class="truncate">Settings</span>
          </NuxtLink>
        </nav>
      </template>
    </nav>
  </div>
</template>
