<script setup lang="ts">
// The contacts list, rendered by the records list view without its type
// switcher — the CRM app is contacts only.
definePageMeta({ middleware: 'auth' })
</script>

<template>
  <RecordsListView
    type-key="contacts"
    :switcher="false"
  />
</template>
