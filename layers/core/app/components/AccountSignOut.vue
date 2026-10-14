<script setup lang="ts">
// Account card: sign out on this device.
const { logout } = useAuth()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        Sign Out
      </h2>
    </template>
    <div class="space-y-4">
      <p class="text-sm text-(--ui-text-muted)">
        Sign out of your account on this device.
      </p>
      <UButton
        color="error"
        variant="outline"
        size="lg"
        @click="logout"
      >
        Sign Out
      </UButton>
    </div>
  </UCard>
</template>
