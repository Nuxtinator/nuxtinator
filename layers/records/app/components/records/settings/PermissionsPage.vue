<script setup lang="ts">
// Roles & permissions — the per-type role grants matrix plus per-user extra
// crm.* grants. Rendered by the org settings shell (multi mode) and the host
// admin shell (single mode). Reachable by anyone with the URL but functionally gated on
// records.schema.manage, same as the rest of the settings pages: the server
// reports access via useRecordsSchemaAdmin's ensureAccess and every route this
// page calls enforces the permission regardless.
const admin = useRecordsSchemaAdmin()
const settingsPath = useRecordsSettingsPath()

const ready = ref(false)

onMounted(async () => {
  await admin.ensureAccess()
  ready.value = true
})

const canManage = admin.canManage
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="flex items-center gap-2">
      <UButton
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Back to records settings"
        :to="settingsPath()"
      />
      <h1 class="flex-1 text-2xl font-semibold tracking-tight text-(--ui-text-highlighted) truncate">
        Roles &amp; permissions
      </h1>
    </header>

    <div class="space-y-8">
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
        description="You need the 'Manage record types' permission to change role grants and user permissions."
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
          <RecordsSettingsRoleGrantsMatrix />
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-base font-semibold">
              Per-user extra permissions
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Grant individual users record permissions on top of their roles.
            </p>
          </div>
          <RecordsSettingsUserGrantsPanel />
        </section>
      </template>
    </div>
  </div>
</template>
