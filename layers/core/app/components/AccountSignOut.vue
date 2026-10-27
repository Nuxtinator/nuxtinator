<script setup lang="ts">
// Account row: sign out on this device.
const { logout } = useAuth()
</script>

<template>
  <SettingsRow
    label="Sign out"
    value="Sign out of your account on this device."
  >
    <template #actions>
      <UButton
        color="neutral"
        variant="outline"
        @click="logout"
      >
        Sign out
      </UButton>
    </template>
  </SettingsRow>
</template>
