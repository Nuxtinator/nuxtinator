<script setup lang="ts">
// Read-only attachments: image thumbnails and file links, each opening the
// file in a new tab.
const props = defineProps<{
  value: unknown
}>()

const files = computed(() => recordsAttachmentList(props.value))
</script>

<template>
  <p
    v-if="files.length === 0"
    class="text-sm sm:pt-1.5"
  >
    —
  </p>
  <div
    v-else
    class="flex flex-wrap items-center gap-2 sm:pt-1"
  >
    <a
      v-for="file in files"
      :key="file.id"
      :href="file.url"
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm text-(--ui-primary) hover:underline"
    >
      <img
        v-if="recordsIsImage(file)"
        :src="file.url"
        :alt="file.name"
        class="size-16 rounded-md object-cover border border-(--ui-border)"
      >
      <span v-else>{{ file.name }}</span>
    </a>
  </div>
</template>
