<script setup lang="ts">
import type { Notification } from '../composables/useNotifications'

// `activeAppId` comes from the layout's resolved current app; it powers the
// "This app" tab and is absent when the user isn't inside any app.
const props = defineProps<{ activeAppId?: string | null }>()

const { items, unreadCount, nextCursor, pending, refresh, loadMore, markRead, start, stop } = useNotifications()
const open = ref(false)
const tab = ref<'all' | 'app'>('all')

onMounted(start)
onBeforeUnmount(stop)

watch(open, (v) => {
  if (v) refresh()
})

const filtered = computed<Notification[]>(() =>
  tab.value === 'app' && props.activeAppId
    ? items.value.filter(n => n.app_id === props.activeAppId)
    : items.value
)

async function openNotification(n: Notification) {
  if (!n.read_at) await markRead([n.id])
  open.value = false
  // Naive link — the tenant route guard adds the /@<slug> prefix in multi mode.
  await navigateTo(n.link)
}

async function markAllRead() {
  await markRead()
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'w-80' }">
    <UChip
      :text="unreadCount > 99 ? '99+' : unreadCount"
      :show="unreadCount > 0"
      size="2xl"
      color="primary"
      inset
    >
      <UButton
        icon="i-lucide-bell"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Notifications"
      />
    </UChip>

    <template #content>
      <div class="flex flex-col">
        <div class="flex items-center justify-between px-3 py-2 border-b border-(--ui-border)">
          <h3 class="text-sm font-semibold">
            Notifications
          </h3>
          <button
            v-if="unreadCount > 0"
            class="text-xs text-(--ui-primary) hover:underline"
            @click="markAllRead"
          >
            Mark all read
          </button>
        </div>

        <!-- Tabs: only offer "This app" when inside an app. -->
        <div
          v-if="activeAppId"
          class="flex items-center gap-1 px-2 py-1.5 border-b border-(--ui-border)"
        >
          <button
            class="tab-btn"
            :class="tab === 'all' ? 'tab-active' : ''"
            @click="tab = 'all'"
          >
            All
          </button>
          <button
            class="tab-btn"
            :class="tab === 'app' ? 'tab-active' : ''"
            @click="tab = 'app'"
          >
            This app
          </button>
        </div>

        <div class="max-h-96 overflow-y-auto">
          <div v-if="filtered.length === 0" class="px-3 py-6 text-center text-sm text-(--ui-text-muted)">
            Nothing new.
          </div>

          <button
            v-for="n in filtered"
            :key="n.id"
            class="w-full text-left flex items-start gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated) border-b border-(--ui-border)/40"
            :class="{ 'bg-(--ui-bg-elevated)/50': !n.read_at }"
            @click="openNotification(n)"
          >
            <UAvatar
              v-if="n.actor"
              :src="n.actor.avatar"
              :alt="n.actor.display_name"
              size="xs"
              class="shrink-0 mt-0.5"
            />
            <UIcon
              v-else
              :name="n.icon"
              class="size-5 shrink-0 mt-0.5 text-(--ui-text-muted)"
            />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">
                {{ n.title }}
              </div>
              <div v-if="n.body" class="text-xs text-(--ui-text-muted) truncate">
                {{ n.body }}
              </div>
              <div class="text-xs text-(--ui-text-muted) mt-0.5">
                <RelativeTime :value="n.created_at" hover-only />
              </div>
            </div>
            <span v-if="!n.read_at" class="size-2 rounded-full bg-(--ui-primary) shrink-0 mt-1.5" />
          </button>

          <button
            v-if="tab === 'all' && nextCursor"
            class="w-full text-center text-xs text-(--ui-primary) hover:underline py-2"
            :disabled="pending"
            @click="loadMore"
          >
            Load more
          </button>
        </div>
      </div>
    </template>
  </UPopover>
</template>

<style scoped>
.tab-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  border-radius: 6px;
  color: var(--ui-text-muted);
}
.tab-btn:hover {
  background: var(--ui-bg-elevated);
}
.tab-active {
  background: var(--ui-bg-accented);
  color: var(--ui-text);
}
</style>
