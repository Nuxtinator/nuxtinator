<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))
</script>

<template>
  <RecordsSettingsTypePage :type-key="typeKey" />
</template>
