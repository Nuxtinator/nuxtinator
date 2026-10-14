<script setup lang="ts">
// Account row: the user's avatar, with upload (when public storage is
// configured) and remove.
const { user, checkAuth } = useAuth()
const toast = useToast()

const { data } = useLazyFetch<{ can_upload: boolean, max_mb: number, types: string[], types_text: string }>('/api/profile/avatar', {
  key: 'profile-avatar',
  default: () => ({ can_upload: false, max_mb: 0, types: [], types_text: '' })
})

const errorMessage = (err: unknown) => (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage

const input = ref<HTMLInputElement | null>(null)
const busy = ref<'upload' | 'remove' | null>(null)

async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (input.value) input.value.value = ''
  if (!file) return
  if (!data.value.types.includes(file.type)) {
    toast.add({ title: `Use a ${data.value.types_text} image`, color: 'error' })
    return
  }
  if (file.size > data.value.max_mb * 1024 * 1024) {
    toast.add({ title: `Image too large (max ${data.value.max_mb} MB)`, color: 'error' })
    return
  }
  busy.value = 'upload'
  try {
    const body = new FormData()
    body.append('file', file)
    await $fetch('/api/profile/avatar', { method: 'POST', body })
    await checkAuth()
    toast.add({ title: 'Avatar updated', color: 'success' })
  } catch (err) {
    toast.add({ title: errorMessage(err) || 'Could not upload the image', color: 'error' })
  } finally {
    busy.value = null
  }
}

async function remove() {
  busy.value = 'remove'
  try {
    await $fetch('/api/profile/avatar', { method: 'DELETE' })
    await checkAuth()
    toast.add({ title: 'Avatar removed', color: 'success' })
  } catch (err) {
    toast.add({ title: errorMessage(err) || 'Could not remove the avatar', color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <AccountRow
    label="Avatar"
    :value="data.can_upload ? `${data.types_text}, up to ${data.max_mb} MB` : undefined"
  >
    <template #leading>
      <UAvatar
        :src="user?.avatar || undefined"
        :alt="user?.display_name"
        size="2xl"
      />
    </template>
    <template #actions>
      <template v-if="data.can_upload">
        <input
          ref="input"
          type="file"
          :accept="data.types.join(',')"
          class="hidden"
          @change="upload"
        >
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-upload"
          :loading="busy === 'upload'"
          :disabled="!!busy"
          @click="input?.click()"
        >
          Upload
        </UButton>
      </template>
      <UButton
        v-if="user?.avatar"
        color="neutral"
        variant="ghost"
        icon="i-lucide-trash-2"
        :loading="busy === 'remove'"
        :disabled="!!busy"
        @click="remove"
      >
        Remove
      </UButton>
    </template>
  </AccountRow>
</template>
