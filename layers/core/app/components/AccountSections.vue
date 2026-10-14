<script setup lang="ts">
// Cards other layers register (e.g. OAuth "Connected apps"); see
// `app/utils/account-section-registry.ts` for the contract.
const injectedSections = getAccountSections()
</script>

<template>
  <component
    :is="section.component"
    v-for="section in injectedSections"
    :key="section.id"
  />
</template>
