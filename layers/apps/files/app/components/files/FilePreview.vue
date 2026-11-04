<script setup lang="ts">
// Preview for an uploaded (kind='file') item: images and videos render inline;
// everything else shows an icon + metadata + download button. `url` is a signed S3 URL.
import { formatBytes, iconForItem, type FilesItemDetail } from '../../composables/useFiles'

const props = defineProps<{ item: FilesItemDetail }>()

const isImage = computed(() => (props.item.mime ?? '').startsWith('image/'))
const isVideo = computed(() => (props.item.mime ?? '').startsWith('video/'))
const lightboxOpen = ref(false)
</script>

<template>
  <div class="flex flex-col items-center gap-4 py-4">
    <img
      v-if="isImage && item.url"
      :src="item.url"
      :alt="item.title"
      class="max-w-full max-h-[85vh] rounded-lg border border-(--ui-border) cursor-zoom-in"
      @click="lightboxOpen = true"
    >
    <FilesImageLightbox
      v-if="isImage && item.url"
      v-model:open="lightboxOpen"
      :src="item.url"
      :alt="item.title"
    />

    <video
      v-else-if="isVideo && item.url"
      :src="item.url"
      controls
      preload="metadata"
      class="max-w-full max-h-[85vh] rounded-lg border border-(--ui-border) bg-black"
    />

    <div
      v-else
      class="flex flex-col items-center gap-3 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) px-10 py-8"
    >
      <UIcon :name="iconForItem(item)" class="size-16 text-(--ui-text-muted)" />
      <div class="text-center">
        <p class="font-medium">{{ item.filename }}</p>
        <p class="text-sm text-(--ui-text-muted)">
          {{ item.mime }}<span v-if="formatBytes(item.size_bytes)"> · {{ formatBytes(item.size_bytes) }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
