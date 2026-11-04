<script setup lang="ts">
// Scope folders: the held review-queue alarm on top, then All / Unassigned /
// Mine. Below them, the per-org tag folders (cross-status). Counts come with
// the list fetch so the rail always matches the list. Scope and tag are
// competing folder dimensions — while a tag is active, no scope folder reads
// selected (and vice-versa), enforced by the composable clearing the other.
import type { InboxCounts, InboxScope } from '../../composables/useInboxConversations'
import type { InboxTag } from '../../composables/useInboxTags'

const props = defineProps<{
  counts: InboxCounts | null
  tags: InboxTag[]
  tagCounts: Record<string, number>
  // Shows the org-admin settings link in the footer (the settings endpoints
  // are admin-gated; non-admins get no dead entry).
  showSettings?: boolean
}>()

const scope = defineModel<InboxScope>('scope', { required: true })
const tag = defineModel<string>('tag', { required: true })

const inboxPath = useInboxPath()

const folders = computed(() => [
  { key: 'held' as const, label: 'Needs review', icon: 'i-lucide-shield-alert', count: props.counts?.held ?? 0, alert: true },
  { key: 'all' as const, label: 'All', icon: 'i-lucide-inbox', count: props.counts?.all ?? 0 },
  { key: 'unassigned' as const, label: 'Unassigned', icon: 'i-lucide-user-x', count: props.counts?.unassigned ?? 0 },
  { key: 'mine' as const, label: 'Mine', icon: 'i-lucide-user-check', count: props.counts?.mine ?? 0 }
])

// Toggle: clicking the active tag folder clears it (back to the scope folders).
function selectTag(slug: string) {
  tag.value = tag.value === slug ? '' : slug
}
</script>

<template>
  <SidebarPanel title="Inbox">
    <nav class="p-2 space-y-0.5">
      <button
        v-for="folder in folders"
        :key="folder.key"
        type="button"
        class="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-left transition-colors"
        :class="!tag && scope === folder.key
          ? 'bg-(--ui-bg-accented) text-(--ui-text-highlighted)'
          : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented)/50'"
        @click="scope = folder.key"
      >
        <UIcon :name="folder.icon" class="size-4 shrink-0" />
        <span class="flex-1 truncate">{{ folder.label }}</span>
        <UBadge
          v-if="folder.count > 0"
          :label="folder.count"
          size="sm"
          variant="subtle"
          :color="folder.alert ? 'warning' : 'neutral'"
        />
      </button>

      <template v-if="tags.length">
        <p class="px-3 pt-3 pb-1 text-xs font-medium text-(--ui-text-dimmed) uppercase tracking-wide">Tags</p>
        <button
          v-for="t in tags"
          :key="t.slug"
          type="button"
          class="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-left transition-colors"
          :class="tag === t.slug
            ? 'bg-(--ui-bg-accented) text-(--ui-text-highlighted)'
            : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented)/50'"
          @click="selectTag(t.slug)"
        >
          <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: inboxTagDotColor(t.color) }" />
          <span class="flex-1 truncate">{{ t.name }}</span>
          <UBadge
            v-if="(tagCounts[t.slug] ?? 0) > 0"
            :label="tagCounts[t.slug]"
            size="sm"
            variant="subtle"
            color="neutral"
          />
        </button>
      </template>
    </nav>

    <template v-if="showSettings" #footer>
      <NuxtLink
        :to="inboxPath('/inbox/settings')"
        class="flex items-center gap-2 text-sm text-(--ui-text-muted) hover:text-(--ui-text) transition-colors"
      >
        <UIcon name="i-lucide-settings" class="size-4 shrink-0" />
        Settings
      </NuxtLink>
    </template>
  </SidebarPanel>
</template>
