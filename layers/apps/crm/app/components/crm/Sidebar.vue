<script setup lang="ts">
// CRM sidebar — record-type switcher. Docked panel on desktop, slideover
// drawer on mobile (same split as the messages sidebar). Renders nothing
// when useCrmSidebar finds nothing to switch between.
import type { SidebarNavItem } from '#core/app/utils/sidebar-nav'

const open = defineModel<boolean>('open', { default: false })

const route = useRoute()
watch(() => route.path, () => {
  open.value = false
})

const { visibleTypes, ensureTypes } = useCrmTypes()
const { canManage, ensureAccess } = useCrmSchemaAdmin()
const { shown } = useCrmSidebar()
const crmPath = useCrmPath()

onMounted(() => {
  ensureTypes().catch(() => {
    // The list page surfaces load errors; the sidebar just stays empty.
  })
  // Server-derived crm.schema.manage signal, cached per org alongside the
  // channel-type catalog. The settings pages and routes enforce the
  // permission themselves; this only shows/hides the link.
  ensureAccess()
})

const items = computed<SidebarNavItem[]>(() =>
  visibleTypes.value.map(t => ({
    to: crmPath(`/${t.key}`),
    label: t.label,
    icon: t.icon ?? 'i-lucide-folder'
  }))
)

const settingsItems = computed<SidebarNavItem[]>(() =>
  canManage.value === true
    ? [{ to: crmPath('/settings'), label: 'Settings', icon: 'i-lucide-settings' }]
    : []
)
</script>

<template>
  <!-- Desktop docked panel -->
  <SidebarPanel
    v-if="shown"
    class="hidden lg:flex w-64 shrink-0"
    title="CRM"
  >
    <SidebarNav
      v-if="items.length > 0"
      :items="items"
    />
    <p
      v-else
      class="text-xs text-(--ui-text-muted) px-2 py-1"
    >
      No record types yet.
    </p>
    <SidebarNav
      v-if="settingsItems.length > 0"
      class="mt-4 pt-4 border-t border-(--ui-border)"
      :items="settingsItems"
    />
  </SidebarPanel>

  <!-- Mobile drawer -->
  <USlideover
    v-if="shown"
    v-model:open="open"
    side="left"
    :ui="{ content: 'max-w-xs' }"
  >
    <template #content>
      <SidebarPanel class="border-r-0">
        <template #header>
          <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold">
              CRM
            </h1>
            <UButton
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              aria-label="Close menu"
              @click="open = false"
            />
          </div>
        </template>
        <SidebarNav
          v-if="items.length > 0"
          :items="items"
        />
        <p
          v-else
          class="text-xs text-(--ui-text-muted) px-2 py-1"
        >
          No record types yet.
        </p>
        <SidebarNav
          v-if="settingsItems.length > 0"
          class="mt-4 pt-4 border-t border-(--ui-border)"
          :items="settingsItems"
        />
      </SidebarPanel>
    </template>
  </USlideover>
</template>
