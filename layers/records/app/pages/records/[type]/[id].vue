<script setup lang="ts">
// A record's detail page in the records app.
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const typeKey = computed(() => String(route.params.type ?? ''))
const recordId = computed(() => String(route.params.id ?? ''))
</script>

<template>
  <RecordsDetailView
    :type-key="typeKey"
    :record-id="recordId"
  />
</template>
