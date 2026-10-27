<script setup lang="ts">
import type { PermissionGroup, PermissionItem } from '../../../../components/OrgPermissionPicker.vue'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const roleId = computed(() => route.params.id as string)
const toast = useToast()
const confirmAction = useConfirm()

interface CustomRole {
  id: string
  name: string
  description: string
  permissions: string[]
}

const { data: permsData } = await useFetch<{ groups: PermissionGroup[], permissions: PermissionItem[] }>(
  () => `/api/o/${orgSlug.value}/permissions`,
  { watch: [orgSlug], default: () => ({ groups: [], permissions: [] }) }
)
const permGroups = computed(() => permsData.value?.groups ?? [])
const allPerms = computed(() => permsData.value?.permissions ?? [])

// The org-scoped roles endpoint returns the full list. Find the one we want.
const { data: rolesData, refresh: refreshRoles } = await useFetch<{ roles: CustomRole[] }>(
  () => `/api/o/${orgSlug.value}/roles`,
  { watch: [orgSlug], default: () => ({ roles: [] }) }
)
const role = computed(() => rolesData.value?.roles.find(r => r.id === roleId.value) ?? null)

const name = ref('')
const description = ref('')
const selected = ref<Set<string>>(new Set())

watch(role, (r) => {
  if (r) {
    name.value = r.name
    description.value = r.description
    selected.value = new Set(r.permissions)
  }
}, { immediate: true })

const dirty = computed(() => {
  const r = role.value
  if (!r) return false
  if (name.value !== r.name || description.value !== r.description) return true
  if (selected.value.size !== r.permissions.length) return true
  return r.permissions.some(p => !selected.value.has(p))
})

const saving = ref(false)
const onSave = async () => {
  saving.value = true
  try {
    await $fetch(`/api/o/${orgSlug.value}/roles/${roleId.value}`, {
      method: 'PUT',
      body: {
        name: name.value.trim(),
        description: description.value.trim(),
        permissions: [...selected.value]
      }
    })
    await refreshRoles()
    toast.add({ title: 'Role saved', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Save failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

const onDelete = async () => {
  if (!role.value) return
  if (!await confirmAction({ title: `Delete role "${role.value.name}"?`, confirmLabel: 'Delete' })) return
  try {
    await $fetch(`/api/o/${orgSlug.value}/roles/${roleId.value}`, { method: 'DELETE' })
    toast.add({ title: 'Role deleted', color: 'success' })
    await navigateTo(`/@${orgSlug.value}/settings/roles`)
  } catch (err: unknown) {
    toast.add({
      title: 'Delete failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <header class="flex items-center justify-between gap-3">
      <h1 class="text-3xl font-bold">
        {{ role?.name || 'Role' }}
      </h1>
      <UButton
        variant="outline"
        :to="`/@${orgSlug}/settings/roles`"
        icon="i-lucide-arrow-left"
      >
        Back
      </UButton>
    </header>

    <div
      v-if="!role"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <form
      v-else
      class="space-y-4"
      @submit.prevent="onSave"
    >
      <UFormField label="Name">
        <UInput
          v-model="name"
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

      <div class="sticky bottom-0 -mx-4 px-4 py-3 flex items-center gap-3 border-t border-(--ui-border) bg-(--ui-bg)/95 backdrop-blur">
        <UButton
          variant="ghost"
          color="error"
          icon="i-lucide-trash-2"
          @click="onDelete"
        >
          Delete role
        </UButton>
        <span class="ml-auto text-sm text-(--ui-text-muted)">
          {{ dirty ? 'Unsaved changes' : `${selected.size} permissions` }}
        </span>
        <UButton
          type="submit"
          :loading="saving"
          :disabled="name.trim().length < 2 || !dirty"
        >
          Save
        </UButton>
      </div>
    </form>
  </div>
</template>
