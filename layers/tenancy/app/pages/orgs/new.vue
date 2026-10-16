<script setup lang="ts">
import { validateSlug } from '#core/app/utils/slug'

definePageMeta({
  middleware: 'auth'
})

const { user } = useAuth()
const router = useRouter()
const { refresh: refreshOrgs } = await useUserOrgs()

const isOperatorAdmin = computed(() => !!(user.value as { is_admin?: boolean } | null)?.is_admin)

const form = reactive({
  name: '',
  slug: ''
})
const loading = ref(false)
const error = ref('')

const slugify = (s: string) => s
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9-\s]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40)

watch(() => form.name, (next, prev) => {
  // Auto-fill slug while it's empty or still tracking the previous name.
  if (form.slug === '' || form.slug === slugify(prev || '')) {
    form.slug = slugify(next)
  }
})

// Live, specific feedback. Empty slug is treated as "no error yet" (the
// submit button stays disabled but we don't shame the user before they type).
const slugFeedback = computed(() => form.slug.length === 0 ? null : validateSlug(form.slug))
const slugOk = computed(() => slugFeedback.value === null && form.slug.length > 0)

async function onSubmit() {
  error.value = ''
  if (form.name.trim().length < 2) {
    error.value = 'Name must be at least 2 characters.'
    return
  }
  if (!slugOk.value) {
    error.value = slugFeedback.value || 'Slug is required.'
    return
  }
  loading.value = true
  try {
    const res = await $fetch<{ slug: string }>('/api/admin/orgs', {
      method: 'POST',
      body: { name: form.name.trim(), slug: form.slug.trim() }
    })
    await refreshOrgs()
    await router.push(launcherPath(res.slug))
  } catch (err: unknown) {
    error.value = (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage || 'Failed to create organization'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="max-w-xl mx-auto space-y-6">
    <h1 class="text-3xl font-bold">
      Create organization
    </h1>

    <UAlert
      v-if="!isOperatorAdmin"
      color="warning"
      title="Only host administrators can create organizations"
      description="Self-serve org signup is not available in this deployment."
    />

    <form
      v-if="isOperatorAdmin"
      class="space-y-4"
      @submit.prevent="onSubmit"
    >
      <UFormField label="Name">
        <UInput
          v-model="form.name"
          size="lg"
          autofocus
          :disabled="loading"
          placeholder="Acme Inc."
        />
      </UFormField>
      <UFormField
        label="Slug"
        :hint="`URL: /@${form.slug || '<slug>'}/`"
        :error="slugFeedback ?? undefined"
      >
        <UInput
          v-model="form.slug"
          size="lg"
          :disabled="loading"
          placeholder="acme"
        />
      </UFormField>
      <UAlert
        v-if="error"
        color="error"
        :title="error"
      />
      <UButton
        type="submit"
        size="lg"
        :loading="loading"
        :disabled="!slugOk || form.name.trim().length < 2"
      >
        Create
      </UButton>
    </form>
  </div>
</template>
