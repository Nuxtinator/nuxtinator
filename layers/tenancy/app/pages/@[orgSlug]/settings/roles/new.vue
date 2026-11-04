<script setup lang="ts">
import type { PermissionGroup, PermissionItem } from '../../../../components/OrgPermissionPicker.vue'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const router = useRouter()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()


const { data: permsData } = await useFetch<{ groups: PermissionGroup[], permissions: PermissionItem[] }>(
  () => `/api/o/${orgSlug.value}/permissions`,
  { watch: [orgSlug], default: () => ({ groups: [], permissions: [] }) }
)
const permGroups = computed(() => permsData.value?.groups ?? [])
const allPerms = computed(() => permsData.value?.permissions ?? [])

const name = ref('')
const description = ref('')
const selected = ref<Set<string>>(new Set())

const saving = ref(false)
const submit = async () => {
  saving.value = true
  try {
    const res = await $fetch<{ id: string }>(
      `/api/o/${orgSlug.value}/roles`,
      {
        method: 'POST',
        body: {
          name: name.value.trim(),
          description: description.value.trim(),
          permissions: [...selected.value]
        }
      }
    )
    toast.add({ title: 'Role created', color: 'success' })
    await router.push(`/@${orgSlug.value}/settings/roles/${res.id}`)
  } catch (err: unknown) {
    toast.add({
      title: 'Create failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-3xl font-bold">
        New custom role
      </h1>
      <UButton
        variant="outline"
        :to="`/@${orgSlug}/settings/roles`"
        icon="i-lucide-arrow-left"
      >
        Cancel
      </UButton>
    </header>

    <form
      class="space-y-4"
      @submit.prevent="submit"
    >
      <UFormField label="Name">
        <UInput
          v-model="name"
          autofocus
          :disabled="saving"
        />
      </UFormField>
      <UFormField label="Description">
        <UInput
          v-model="description"
          :disabled="saving"
        />
      </UFormField>

      <div class="space-y-2">
        <h2 class="font-semibold">
          Permissions
        </h2>
        <OrgPermissionPicker
          v-model="selected"
          :groups="permGroups"
          :permissions="allPerms"
          :disabled="saving"
        />
      </div>

      <div class="sticky bottom-0 -mx-4 px-4 py-3 flex items-center justify-end gap-3 border-t border-(--ui-border) bg-(--ui-bg)/95 backdrop-blur">
        <span class="text-sm text-(--ui-text-muted)">
          {{ selected.size }} permissions selected
        </span>
        <UButton
          type="submit"
          :loading="saving"
          :disabled="name.trim().length < 2 || selected.size === 0"
        >
          Create role
        </UButton>
      </div>
    </form>
  </div>
</template>
