<script setup lang="ts">
// Attachments editor: images as thumbnails, other files as rows, each with a
// remove button, plus an upload button. Removing commits the remaining files
// (the server keeps those, in that order); uploading posts the chosen files
// to `uploadUrl` and emits `uploaded` so the parent refetches. Without an
// upload URL (a record not saved yet) only removing is offered.
import type { RecordsAttachmentValue } from '#records'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
  uploadUrl?: string
}>()

const emit = defineEmits<{
  commit: [value: RecordsAttachmentValue[]]
  uploaded: [files: RecordsAttachmentValue[]]
}>()

const toast = useToast()
const files = computed(() => recordsAttachmentList(props.modelValue))
const images = computed(() => files.value.filter(recordsIsImage))
const others = computed(() => files.value.filter(f => !recordsIsImage(f)))

function remove(id: string) {
  emit('commit', files.value.filter(f => f.id !== id))
}

const input = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

async function onPick(event: Event) {
  const picked = Array.from((event.target as HTMLInputElement).files ?? [])
  if (input.value) input.value.value = ''
  if (picked.length === 0 || !props.uploadUrl) return
  const form = new FormData()
  for (const file of picked) form.append('file', file)
  uploading.value = true
  try {
    const res = await $fetch<{ files: RecordsAttachmentValue[] }>(props.uploadUrl, { method: 'POST', body: form })
    emit('uploaded', res.files)
  } catch (err) {
    toast.add({ title: 'Upload failed', description: recordsErrorMessage(err, 'Failed to upload'), color: 'error' })
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-if="images.length > 0"
      class="flex flex-wrap gap-2"
    >
      <div
        v-for="file in images"
        :key="file.id"
        class="relative group"
      >
        <a
          :href="file.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            :src="file.url"
            :alt="file.name"
            class="size-20 rounded-md object-cover border border-(--ui-border)"
          >
        </a>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="solid"
          size="xs"
          class="absolute -top-2 -right-2 rounded-full opacity-0 group-hover:opacity-100 focus:opacity-100"
          :aria-label="`Remove ${file.name}`"
          @click="remove(file.id)"
        />
      </div>
    </div>
    <div
      v-for="file in others"
      :key="file.id"
      class="flex items-center gap-2"
    >
      <UIcon
        name="i-lucide-file"
        class="size-4 shrink-0 text-(--ui-text-muted)"
      />
      <a
        :href="file.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-(--ui-primary) hover:underline truncate"
      >{{ file.name }}</a>
      <span class="text-xs text-(--ui-text-muted) shrink-0">{{ recordsFileSize(file.size) }}</span>
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="`Remove ${file.name}`"
        @click="remove(file.id)"
      />
    </div>
    <template v-if="uploadUrl">
      <input
        ref="input"
        type="file"
        multiple
        class="hidden"
        @change="onPick"
      >
      <UButton
        icon="i-lucide-upload"
        variant="soft"
        size="sm"
        :loading="uploading"
        @click="input?.click()"
      >
        Add files
      </UButton>
    </template>
  </div>
</template>
