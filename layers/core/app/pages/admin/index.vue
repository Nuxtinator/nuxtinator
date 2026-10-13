<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const { sections } = await useAdminSections()
const links = computed(() => sections.value.filter(s => s.path !== '/admin'))
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold mb-6">
      Dashboard
    </h1>
    <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
      <NuxtLink
        v-for="section in links"
        :key="section.path"
        :to="section.path"
        class="flex flex-col items-start rounded-md border border-(--ui-border) p-4 bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated) transition-colors"
      >
        <UIcon
          :name="section.icon ?? 'i-lucide-circle'"
          class="size-6 mb-2"
        />
        <div class="font-medium">
          {{ section.title }}
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
