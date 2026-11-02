<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold">
        AI spend
      </h1>
    </header>

    <AiSpend view="host" />
  </div>
</template>
