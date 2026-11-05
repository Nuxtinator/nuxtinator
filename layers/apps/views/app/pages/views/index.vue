<script setup lang="ts">
// Views landing — the accessible-views list grouped mine / shared with
// me / org-wide, plus the create entry point.
import type { ViewSummary } from '../../utils/views-types'

definePageMeta({ middleware: 'auth' })

const viewsPath = useViewsPath()
const { pending, error, refresh, mine, sharedWithMe, orgWide, items } = useViewsList()
const createOpen = ref(false)

onMounted(() => {
  refresh()
})

const groups = computed(() => [
  { key: 'mine', title: 'My views', views: mine.value },
  { key: 'shared', title: 'Shared with me', views: sharedWithMe.value },
  { key: 'org', title: 'Organization', views: orgWide.value }
].filter(g => g.views.length > 0))

const showEmpty = computed(() => !pending.value && !error.value && items.value.length === 0)

function viewIcon(view: ViewSummary): string {
  if (view.icon) return view.icon
  return VIEWS_LAYOUT_META[view.layout].icon
}

const VISIBILITY_BADGES: Record<string, { label: string, icon: string }> = {
  private: { label: 'Private', icon: 'i-lucide-lock' },
  teams: { label: 'Teams', icon: 'i-lucide-users' },
  org: { label: 'Organization', icon: 'i-lucide-building-2' }
}
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <header class="flex items-center gap-2">
      <h1 class="flex-1 text-lg font-semibold">
        Views
      </h1>
      <UButton
        icon="i-lucide-plus"
        @click="createOpen = true"
      >
        New view
      </UButton>
    </header>

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <div
      v-else-if="showEmpty"
      class="grid place-items-center py-24 text-(--ui-text-muted)"
    >
      <div class="text-center max-w-sm space-y-3">
        <UIcon
          name="i-lucide-kanban"
          class="size-10 opacity-50"
        />
        <p class="text-sm">
          No views yet. Create a kanban board or table over any record type — tasks, items, contacts, or one your org created.
        </p>
        <UButton
          icon="i-lucide-plus"
          @click="createOpen = true"
        >
          New view
        </UButton>
      </div>
    </div>

    <section
      v-for="group in groups"
      v-else
      :key="group.key"
      class="space-y-2"
    >
      <h2 class="text-sm font-medium text-(--ui-text-muted)">
        {{ group.title }}
      </h2>
      <ul class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) bg-(--ui-bg)">
        <li
          v-for="view in group.views"
          :key="view.id"
        >
          <NuxtLink
            :to="viewsPath(`/${view.id}`)"
            class="flex items-center gap-3 px-4 py-3 hover:bg-(--ui-bg-elevated) transition-colors"
          >
            <UIcon
              :name="viewIcon(view)"
              class="size-5 text-(--ui-text-muted)"
            />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium truncate">
                {{ view.name }}
              </p>
              <p class="text-xs text-(--ui-text-muted) truncate">
                {{ view.recordTypeKey }} · {{ view.tabCount === 1 ? VIEWS_LAYOUT_META[view.layout].label : `${view.tabCount} tabs` }}
                <template v-if="group.key !== 'mine'">
                  · by {{ view.ownerName }}
                </template>
              </p>
            </div>
            <UBadge
              v-if="group.key === 'mine' && VISIBILITY_BADGES[view.visibility]"
              variant="subtle"
              color="neutral"
              :icon="VISIBILITY_BADGES[view.visibility]!.icon"
            >
              {{ VISIBILITY_BADGES[view.visibility]!.label }}
            </UBadge>
          </NuxtLink>
        </li>
      </ul>
    </section>

    <ViewsViewCreateModal v-model:open="createOpen" />
  </div>
</template>
