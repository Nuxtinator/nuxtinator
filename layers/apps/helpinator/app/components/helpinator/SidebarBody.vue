<script setup lang="ts">
import type { HelpinatorLibrary } from '../../utils/helpinator-types'

// The helpinator nav: "All conversations", then one channel per widget.
// Channels filter the conversation list via `?widget=<id>`; managers get a cog
// on each channel linking to that widget's settings, and a Libraries section.
defineProps<{
  // Highlights a channel off the list page (e.g. the widget a transcript came from).
  activeWidgetId?: string | null
}>()
defineEmits<{ navigated: [] }>()

interface SidebarWidget {
  id: string
  name: string
  // Only returned to managers.
  enabled?: boolean
}

const route = useRoute()
const pathTo = useHelpinatorPath()
const { data: status } = useHelpinatorStatus()
const { data: widgets } = useFetch<SidebarWidget[]>('/api/helpinator/widgets', {
  key: 'helpinator-sidebar-widgets',
  default: () => []
})

const { data: libraries } = useFetch<HelpinatorLibrary[]>('/api/helpinator/libraries', {
  key: 'helpinator-sidebar-libraries',
  default: () => [],
  // The endpoint is managers-only; wait for status before asking.
  immediate: false
})
watch(() => status.value?.canManage, (canManage) => {
  if (canManage) refreshNuxtData('helpinator-sidebar-libraries')
}, { immediate: true })

const listPath = computed(() => pathTo('/helpinator'))
const onList = computed(() => route.path === listPath.value)
const queryWidget = computed(() => typeof route.query.widget === 'string' ? route.query.widget : null)

const librariesPath = computed(() => pathTo('/helpinator/libraries'))
const widgetPath = (id: string) => pathTo(`/helpinator/widgets/${id}`)
const isAt = (path: string) => route.path === path

const allActive = computed(() => onList.value && !queryWidget.value)

const itemClass = (active: boolean) => active
  ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
  : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'
</script>

<template>
  <div class="flex flex-col gap-4" @click="$emit('navigated')">
    <nav class="flex flex-col gap-px">
      <NuxtLink
        :to="listPath"
        class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
        :class="itemClass(allActive)"
      >
        <UIcon name="i-lucide-messages-square" class="size-4 shrink-0" />
        <span class="truncate flex-1">All conversations</span>
      </NuxtLink>
    </nav>

    <HelpinatorSidebarSection
      id="channels"
      title="Channels"
      :add-to="status?.canManage ? pathTo('/helpinator/widgets/new') : undefined"
      add-label="New widget"
    >
      <p v-if="widgets.length === 0" class="px-2 py-2 text-xs text-(--ui-text-muted)">
        No widgets yet.
      </p>

      <nav class="flex flex-col gap-px">
        <div
          v-for="w in widgets"
          :key="w.id"
          class="group flex items-center rounded-md transition"
          :class="itemClass(onList ? queryWidget === w.id : (activeWidgetId === w.id || isAt(widgetPath(w.id))))"
        >
          <NuxtLink
            :to="{ path: listPath, query: { widget: w.id } }"
            class="flex items-center gap-2 pl-2 py-1.5 text-sm min-w-0 flex-1"
            :class="status?.canManage ? 'pr-1' : 'pr-2'"
          >
            <UIcon name="i-lucide-app-window" class="size-4 shrink-0" />
            <span class="truncate flex-1" :class="{ 'opacity-60': w.enabled === false }">{{ w.name }}</span>
            <span v-if="w.enabled === false" class="text-[10px] uppercase tracking-wide text-(--ui-text-dimmed)">Off</span>
          </NuxtLink>
          <NuxtLink
            v-if="status?.canManage"
            :to="widgetPath(w.id)"
            :aria-label="`${w.name} settings`"
            title="Widget settings"
            class="shrink-0 mr-1 p-1 rounded text-(--ui-text-dimmed) hover:text-(--ui-text) focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
            :class="{ 'lg:opacity-100 text-(--ui-text)': isAt(widgetPath(w.id)) }"
          >
            <UIcon name="i-lucide-settings" class="size-3.5 block" />
          </NuxtLink>
        </div>
      </nav>
    </HelpinatorSidebarSection>

    <template v-if="status?.canManage">
      <HelpinatorSidebarSection
        id="libraries"
        title="Libraries"
        :add-to="pathTo('/helpinator/libraries/new')"
        add-label="New library"
      >
        <nav class="flex flex-col gap-px">
          <NuxtLink
            :to="librariesPath"
            class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
            :class="itemClass(isAt(librariesPath))"
          >
            <UIcon name="i-lucide-library" class="size-4 shrink-0" />
            <span class="truncate flex-1">All libraries</span>
          </NuxtLink>
          <NuxtLink
            v-for="l in libraries"
            :key="l.id"
            :to="pathTo(`/helpinator/libraries/${l.id}`)"
            class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
            :class="itemClass(isAt(pathTo(`/helpinator/libraries/${l.id}`)))"
          >
            <UIcon :name="l.kind === 'portfolio' ? 'i-lucide-book-open' : 'i-lucide-globe'" class="size-4 shrink-0" />
            <span class="truncate flex-1">{{ l.name }}</span>
          </NuxtLink>
        </nav>
      </HelpinatorSidebarSection>
    </template>
  </div>
</template>
