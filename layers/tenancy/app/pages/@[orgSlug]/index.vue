<script setup lang="ts">
// The org's home is its launcher at `/@<slug>/dashboard`.
definePageMeta({
  redirect: to => `/@${to.params.orgSlug}/dashboard`
})
</script>

<template>
  <div />
</template>
