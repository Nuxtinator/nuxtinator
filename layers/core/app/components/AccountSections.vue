<script setup lang="ts">
// Layer-injected sections (e.g. OAuth "Connected apps"). Each layer
// registers its own card via a Nuxt app plugin — see
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
