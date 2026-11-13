<script setup lang="ts">
// Popover content for setting an image: a drop zone that also opens the file
// browser, and Remove when there is an image. The parent checks the chosen
// file and stores it.
export interface ImageUploadInfo {
  can_upload: boolean
  max_mb: number
  types: string[]
  types_text: string
}

defineProps<{
  /** What an upload accepts, from `GET /api/profile/avatar`. */
  info: ImageUploadInfo
  hasImage: boolean
}>()

const emit = defineEmits<{ choose: [file: File], remove: [] }>()

const onChoose = (file: File | null | undefined) => {
  if (file) emit('choose', file)
}
</script>

<template>
  <div class="p-3 space-y-2">
    <UFileUpload
      v-if="info.can_upload"
      :model-value="null"
      :accept="info.types.join(',')"
      reset
      variant="area"
      icon="i-lucide-image-up"
      :label="hasImage ? 'Drop a new image here or click to upload' : 'Drop an image here or click to upload'"
      :description="`${info.types_text}, up to ${info.max_mb} MB`"
      :preview="false"
      class="w-full"
      :ui="{ base: 'data-[dragging=true]:border-(--ui-primary)' }"
      @update:model-value="onChoose"
    />
    <UButton
      v-if="hasImage"
      color="neutral"
      variant="ghost"
      icon="i-lucide-trash-2"
      @click="emit('remove')"
    >
      Remove
    </UButton>
  </div>
</template>
