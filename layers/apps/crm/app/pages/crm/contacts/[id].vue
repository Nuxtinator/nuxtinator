<script setup lang="ts">
// A contact's detail page, rendered by the records detail view.
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const recordId = computed(() => String(route.params.id ?? ''))
</script>

<template>
  <RecordsDetailView
    type-key="contacts"
    :record-id="recordId"
  />
</template>
