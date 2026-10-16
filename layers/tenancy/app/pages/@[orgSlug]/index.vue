<script setup lang="ts">
// The org's home is its launcher at `/@<slug>/dashboard`.
definePageMeta({
  redirect: to => ({ path: `/@${to.params.orgSlug}/dashboard`, query: to.query, hash: to.hash })
})
</script>

<template>
  <div />
</template>
