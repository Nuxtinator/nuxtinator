<script setup lang="ts">
// A record type's list in the records app.
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))
</script>

<template>
  <RecordsListView :type-key="typeKey" />
</template>
