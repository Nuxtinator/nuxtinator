<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)

const { data: org, pending } = await useFetch<{
  id: string
  slug: string
  name: string
  member_count: number
  perms: string[]
}>(() => `/api/o/${orgSlug.value}`, {
  watch: [orgSlug],
  key: () => `org-settings-detail-${orgSlug.value}`
})

const formName = ref('')
const formSlug = ref('')
const saving = ref(false)
const saveErr = ref('')
const saveOk = ref('')

watch(org, (next) => {
  if (next) {
    formName.value = next.name
    formSlug.value = next.slug
  }
}, { immediate: true })

async function save() {
  saving.value = true
  saveErr.value = ''
  saveOk.value = ''
  try {
    const updated = await $fetch<{ slug: string, name: string }>(
      `/api/o/${orgSlug.value}`,
      {
        method: 'PATCH',
        body: { name: formName.value.trim(), slug: formSlug.value.trim() }
      }
    )
    saveOk.value = 'Saved.'
    if (updated.slug !== orgSlug.value) {
      // Hard cutover — old path stops working immediately.
      await navigateTo(`/@${updated.slug}/settings`)
    }
  } catch (err: unknown) {
    saveErr.value = (err as { data?: { statusMessage?: string } })?.data?.statusMessage || 'Failed to save'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <div class="space-y-4">
      <PageTitle title="General" />

      <div
        v-if="pending && !org"
        class="text-sm text-(--ui-text-muted)"
      >
        Loading...
      </div>

      <form
        v-else-if="org"
        class="space-y-4 max-w-md"
        @submit.prevent="save"
      >
        <UFormField label="Name">
          <UInput
            v-model="formName"
            size="lg"
            :disabled="saving"
          />
        </UFormField>
        <UFormField
          label="Slug"
          help="Hard cutover — old paths break immediately when you change this."
        >
          <UInput
            v-model="formSlug"
            size="lg"
            :disabled="saving"
          />
        </UFormField>
        <UAlert
          v-if="saveErr"
          color="error"
          :title="saveErr"
        />
        <UAlert
          v-if="saveOk"
          color="success"
          :title="saveOk"
        />
        <UButton
          type="submit"
          :loading="saving"
          :disabled="!formName.trim() || !formSlug.trim()"
        >
          Save
        </UButton>
      </form>
    </div>
  </div>
</template>
