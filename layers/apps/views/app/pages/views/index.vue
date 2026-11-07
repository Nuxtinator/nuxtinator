<script setup lang="ts">
// Views landing — two columns by audience: Teams (views open to a team or
// everyone, whoever owns them) and Mine (my private views, then private views
// shared with me by name). Each column's + opens the create modal set to that
// audience.
definePageMeta({ middleware: 'auth' })

const { pending, error, refresh, teamViews, mine, sharedWithMe } = useViewsList()
const createOpen = ref(false)
const createAudience = ref<'mine' | 'teams'>('mine')

onMounted(() => {
  refresh()
})

function openCreate(audience: 'mine' | 'teams') {
  createAudience.value = audience
  createOpen.value = true
}
</script>

<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <h1 class="text-lg font-semibold">
      Views
    </h1>

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <div
      v-else
      class="grid gap-6 md:grid-cols-2 items-start"
    >
      <section class="space-y-2">
        <header class="flex items-center gap-2">
          <h2 class="flex-1 text-sm font-medium text-(--ui-text-muted)">
            Teams
          </h2>
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            size="xs"
            aria-label="New team view"
            @click="openCreate('teams')"
          />
        </header>
        <ul
          v-if="teamViews.length > 0"
          class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) bg-(--ui-bg)"
        >
          <li
            v-for="view in teamViews"
            :key="view.id"
          >
            <ViewsViewRow
              :view="view"
              show-owner
              audience
            />
          </li>
        </ul>
        <p
          v-else-if="!pending"
          class="text-sm text-(--ui-text-muted) py-3"
        >
          No views for your teams yet.
        </p>
      </section>

      <section class="space-y-2">
        <header class="flex items-center gap-2">
          <h2 class="flex-1 text-sm font-medium text-(--ui-text-muted)">
            Mine
          </h2>
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            size="xs"
            aria-label="New view"
            @click="openCreate('mine')"
          />
        </header>
        <ul
          v-if="mine.length > 0"
          class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) bg-(--ui-bg)"
        >
          <li
            v-for="view in mine"
            :key="view.id"
          >
            <ViewsViewRow :view="view" />
          </li>
        </ul>
        <p
          v-else-if="!pending"
          class="text-sm text-(--ui-text-muted) py-3"
        >
          No views of your own yet.
        </p>

        <template v-if="sharedWithMe.length > 0">
          <h3 class="pt-4 text-xs font-medium text-(--ui-text-dimmed)">
            Shared with me
          </h3>
          <ul class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) bg-(--ui-bg)">
            <li
              v-for="view in sharedWithMe"
              :key="view.id"
            >
              <ViewsViewRow
                :view="view"
                show-owner
              />
            </li>
          </ul>
        </template>
      </section>
    </div>

    <ViewsViewCreateModal
      v-model:open="createOpen"
      :audience="createAudience"
    />
  </div>
</template>
