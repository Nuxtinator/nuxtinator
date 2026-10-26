<script setup lang="ts">
// Roles & permissions — the per-type role grants matrix plus per-user extra
// crm.* grants. Reachable by anyone with the URL but functionally gated on
// crm.schema.manage, same as the rest of the settings pages: the server
// reports access via useCrmSchemaAdmin's ensureAccess and every route this
// page calls enforces the permission regardless.
definePageMeta({ middleware: 'auth' })

const admin = useCrmSchemaAdmin()
const crmPath = useCrmPath()

const sidebarOpen = ref(false)
const { shown: sidebarShown } = useCrmSidebar()
const ready = ref(false)

onMounted(async () => {
  await admin.ensureAccess()
  ready.value = true
})

const canManage = admin.canManage
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <CrmSidebar v-model:open="sidebarOpen" />

    <section
      class="flex-1 flex flex-col min-w-0 border-l-0 border-(--ui-border) overflow-hidden"
      :class="{ 'lg:border-l': sidebarShown }"
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          v-if="sidebarShown"
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open record types"
          @click="sidebarOpen = true"
        />
        <UButton
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Back to CRM settings"
          :to="crmPath('/settings')"
        />
        <h1 class="flex-1 text-lg font-semibold truncate">
          Roles &amp; permissions
        </h1>
      </header>

      <div class="flex-1 overflow-y-auto p-4 space-y-8">
        <div
          v-if="!ready"
          class="grid place-items-center py-24 text-(--ui-text-muted)"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-6 animate-spin"
          />
        </div>

        <UAlert
          v-else-if="!canManage"
          color="warning"
          icon="i-lucide-lock"
          title="Schema management requires permission"
          description="You need the 'Manage CRM schema' permission to change role grants and user permissions."
        />

        <template v-else>
          <section class="space-y-3">
            <div>
              <h2 class="text-base font-semibold">
                Role access by record type
              </h2>
              <p class="text-sm text-(--ui-text-muted)">
                Override what each role may do with one record type. Cells left on
                Inherit follow the role's permission slugs.
              </p>
            </div>
            <CrmSettingsRoleGrantsMatrix />
          </section>

          <section class="space-y-3">
            <div>
              <h2 class="text-base font-semibold">
                Per-user extra permissions
              </h2>
              <p class="text-sm text-(--ui-text-muted)">
                Grant individual users CRM permissions on top of their roles.
              </p>
            </div>
            <CrmSettingsUserGrantsPanel />
          </section>
        </template>
      </div>
    </section>
  </div>
</template>
