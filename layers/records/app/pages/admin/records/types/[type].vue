<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))
</script>

<template>
  <RecordsSettingsTypePage :type-key="typeKey" />
</template>
