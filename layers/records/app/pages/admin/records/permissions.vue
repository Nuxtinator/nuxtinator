<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})
</script>

<template>
  <RecordsSettingsPermissionsPage />
</template>
