<script setup lang="ts">
// One open view, full page. The view itself is ViewsViewPanel.
definePageMeta({ middleware: 'auth' })

const route = useRoute()
const viewId = computed(() => String(route.params.id ?? ''))
</script>

<template>
  <ViewsViewPanel :view-id="viewId" />
</template>
