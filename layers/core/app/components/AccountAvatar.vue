<script setup lang="ts">
// Account card: the user's avatar, with upload (when public storage is
// configured) and remove.
const { user, checkAuth } = useAuth()
const toast = useToast()

const { data } = useLazyFetch<{ can_upload: boolean, max_mb: number, types: string[] }>('/api/profile/avatar', {
  key: 'profile-avatar',
  default: () => ({ can_upload: false, max_mb: 0, types: [] })
})

const input = ref<HTMLInputElement | null>(null)
const busy = ref<'upload' | 'remove' | null>(null)

async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (input.value) input.value.value = ''
  if (!file) return
  if (!data.value.types.includes(file.type)) {
    toast.add({ title: 'Use a JPEG, PNG, GIF or WebP image', color: 'error' })
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
  } catch (err: any) {
    toast.add({ title: err?.data?.statusMessage || 'Could not upload the image', color: 'error' })
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
  } catch (err: any) {
    toast.add({ title: err?.data?.statusMessage || 'Could not remove the avatar', color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        Avatar
      </h2>
    </template>
    <div class="flex items-center gap-4">
      <UAvatar
        :src="user?.avatar || undefined"
        :alt="user?.display_name"
        size="3xl"
      />
      <div class="flex flex-wrap gap-2">
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
            Upload image
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
      </div>
    </div>
  </UCard>
</template>
