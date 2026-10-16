<script setup lang="ts">
// The signed-in launcher. In multi-tenant mode the tenancy route guard sends
// `/dashboard` to the active org's `/@<slug>/dashboard` before this renders.
definePageMeta({
  middleware: 'auth'
})

const { apps, pending } = await useApps()
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-3">
    <h1 class="text-lg font-semibold">
      Apps
    </h1>
    <div
      v-if="pending && apps.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>
    <AppLauncherGrid
      v-else
      :apps="apps"
      empty-text="No apps installed."
    />
  </div>
</template>
