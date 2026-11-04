<script setup lang="ts">
// The signed-in launcher. In multi-tenant mode the tenancy route guard sends
// `/dashboard` to the active org's `/@<slug>/dashboard` when there is one;
// without an org this page lists only personal apps and links to the org picker.
definePageMeta({
  middleware: 'auth'
})

const tenancyOn = !!useRuntimeConfig().public.tenancy
const { orgApps, personalApps, pending } = await useApps()
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <div
      v-if="pending && orgApps.length === 0 && personalApps.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>
    <template v-else>
      <section
        v-if="!tenancyOn"
        class="space-y-3"
      >
        <h1 class="text-lg font-semibold">
          Apps
        </h1>
        <AppLauncherGrid
          :apps="orgApps"
          :empty-text="personalApps.length ? 'No shared apps installed.' : 'No apps installed.'"
        />
      </section>
      <section
        v-if="personalApps.length || tenancyOn"
        class="space-y-3"
      >
        <h2 class="text-lg font-semibold">
          Personal
        </h2>
        <AppLauncherGrid
          :apps="personalApps"
          empty-text="No personal apps yet."
        />
      </section>
      <UButton
        v-if="tenancyOn"
        to="/orgs"
        variant="outline"
        icon="i-lucide-building-2"
      >
        Organizations
      </UButton>
    </template>
  </div>
</template>
