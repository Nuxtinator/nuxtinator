<script setup lang="ts">
// One view in a landing-page list: icon, name, record type and layout, the
// owner when it isn't the caller's own, and its audience (team avatars or
// Everyone) when `audience` is set.
import type { ViewSummary } from '../../utils/views-types'

const props = defineProps<{
  view: ViewSummary
  showOwner?: boolean
  audience?: boolean
}>()

const viewsPath = useViewsPath()

const icon = computed(() => props.view.icon || VIEWS_LAYOUT_META[props.view.layout].icon)
const teams = computed(() => props.view.teams.filter(t => !t.archived))
</script>

<template>
  <NuxtLink
    :to="viewsPath(`/${view.id}`)"
    class="flex items-center gap-3 px-4 py-3 hover:bg-(--ui-bg-elevated) transition-colors"
  >
    <UIcon
      :name="icon"
      class="size-5 shrink-0 text-(--ui-text-muted)"
    />
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium truncate">
        {{ view.name }}
      </p>
      <p class="text-xs text-(--ui-text-muted) truncate">
        {{ view.recordTypeKey }} · {{ view.tabCount === 1 ? VIEWS_LAYOUT_META[view.layout].label : `${view.tabCount} tabs` }}
        <template v-if="showOwner">
          · by {{ view.ownerName }}
        </template>
      </p>
    </div>
    <template v-if="audience">
      <UBadge
        v-if="view.visibility === 'org'"
        variant="subtle"
        color="neutral"
        icon="i-lucide-users"
      >
        Everyone
      </UBadge>
      <UAvatarGroup
        v-else-if="teams.length > 0"
        :max="3"
        size="2xs"
        :title="teams.map(t => t.name).join(', ')"
      >
        <UAvatar
          v-for="t in teams"
          :key="t.id"
          v-bind="groupAvatarProps(t)"
        />
      </UAvatarGroup>
    </template>
  </NuxtLink>
</template>
