<script setup lang="ts">
// A person's avatar: their image, else their initials. When `editable`,
// clicking it opens a popover to upload an image or remove the current one,
// saved at once through `endpoint`:
//   POST   {endpoint}   multipart `file` → { avatar }
//   DELETE {endpoint}
import { h } from 'vue'
import type { ImageUploadInfo } from './ImagePickerPanel.vue'

const props = withDefaults(defineProps<{
  userId: string
  endpoint: string
  avatar: string | null
  name: string
  email?: string | null
  editable?: boolean
  // A prop rather than an emit, so a save that finishes after this component
  // is gone (its slideover closed) still reaches the page.
  onUpdate?: (userId: string, avatar: string | null) => void | Promise<void>
}>(), {
  email: null,
  editable: true,
  onUpdate: undefined
})

const toast = useToast()

const { data: info } = useLazyFetch<ImageUploadInfo>('/api/profile/avatar', {
  key: 'profile-avatar',
  default: () => ({ can_upload: false, max_mb: 0, types: [], types_text: '' })
})

const open = ref(false)
const busy = ref(false)

// Without uploads and without an image to remove there is nothing to offer.
const canEdit = computed(() => props.editable && (info.value.can_upload || !!props.avatar))

const initials = computed(() => {
  const source = (props.name || props.email || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  return source.slice(0, 2).toUpperCase()
})

const Face = () => props.avatar
  ? h('img', {
      src: props.avatar,
      alt: props.name,
      class: 'size-16 rounded-full object-cover ring-1 ring-(--ui-border) shadow-sm'
    })
  : h('div', {
      class: 'size-16 rounded-full bg-gradient-to-br from-(--ui-primary) to-(--ui-primary)/60 text-white flex items-center justify-center text-xl font-semibold ring-1 ring-(--ui-border) shadow-sm'
    }, initials.value)

const errorMessage = (err: unknown) => (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage

// `save` returns the new avatar. The target is read before the request, so
// the result lands on the user it was made for.
async function run(save: (endpoint: string) => Promise<string | null>, done: string, failed: string) {
  const { userId, endpoint, onUpdate } = props
  open.value = false
  busy.value = true
  try {
    const avatar = await save(endpoint)
    await onUpdate?.(userId, avatar)
    toast.add({ title: done, color: 'success' })
  } catch (err) {
    toast.add({ title: errorMessage(err) || failed, color: 'error' })
  } finally {
    busy.value = false
  }
}

function upload(file: File) {
  if (!info.value.types.includes(file.type)) {
    toast.add({ title: `Use a ${info.value.types_text} image`, color: 'error' })
    return
  }
  if (file.size > info.value.max_mb * 1024 * 1024) {
    toast.add({ title: `Image too large (max ${info.value.max_mb} MB)`, color: 'error' })
    return
  }
  const body = new FormData()
  body.append('file', file)
  return run(
    async endpoint => (await $fetch<{ avatar: string }>(endpoint, { method: 'POST', body })).avatar,
    'Avatar updated',
    'Could not upload the image'
  )
}

function remove() {
  return run(
    async (endpoint) => {
      await $fetch(endpoint, { method: 'DELETE' })
      return null
    },
    'Avatar removed',
    'Could not remove the avatar'
  )
}
</script>

<template>
  <UPopover
    v-if="canEdit"
    v-model:open="open"
    :ui="{ content: 'w-72' }"
  >
    <button
      type="button"
      class="relative shrink-0 rounded-full cursor-pointer disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
      :disabled="busy"
      aria-label="Change avatar"
      title="Change avatar"
    >
      <Face />
      <span
        v-if="busy"
        class="absolute inset-0 flex items-center justify-center rounded-full bg-(--ui-bg)/60"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
      </span>
      <span
        v-else
        class="absolute bottom-0 right-0 flex items-center justify-center size-5 rounded-full bg-(--ui-bg) ring ring-(--ui-border-accented) text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-pencil"
          class="size-3"
        />
      </span>
    </button>
    <template #content>
      <ImagePickerPanel
        :info="info"
        :has-image="!!avatar"
        @choose="upload"
        @remove="remove"
      />
    </template>
  </UPopover>
  <div
    v-else
    class="shrink-0"
  >
    <Face />
  </div>
</template>
