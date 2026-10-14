<script setup lang="ts">
// Account row: when the account was created.
const { user } = useAuth()
</script>

<template>
  <AccountRow
    label="Member since"
    :value="user?.created ? new Date(user.created).toLocaleDateString() : undefined"
  />
</template>
