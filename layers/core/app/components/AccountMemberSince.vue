<script setup lang="ts">
// Account row: when the account was created.
const { user } = useAuth()
</script>

<template>
  <SettingsRow
    label="Member since"
    :value="user?.created ? formatDateOnly(user.created) : undefined"
  />
</template>
