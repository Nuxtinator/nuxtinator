<script setup lang="ts">
// CRM landing — the contacts list.
definePageMeta({ middleware: 'auth' })

const typePath = useRecordsTypePath()
onMounted(() => {
  navigateTo(typePath('contacts'), { replace: true })
})
</script>

<template>
  <div />
</template>
