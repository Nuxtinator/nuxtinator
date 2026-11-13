<script setup lang="ts">
import type { GroupsManagerUser } from '#core/app/components/GroupsManager.vue'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

interface AdminOrg {
  id: string
  slug: string
  name: string
  suspended: boolean
  created_at: string
  member_count: number
  app_count: number
}

const { data, pending, refresh } = await useFetch<{ orgs: AdminOrg[] }>(
  '/api/admin/orgs',
  { default: () => ({ orgs: [] }) }
)
const orgs = computed(() => data.value?.orgs ?? [])

const toast = useToast()
const deleteTarget = ref<AdminOrg | null>(null)
const deleteConfirm = ref('')
const deleting = ref(false)
const deleteModalOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open) => { if (!open) deleteTarget.value = null }
})

const groupsOrg = ref<AdminOrg | null>(null)
const groupsOpen = computed({
  get: () => groupsOrg.value !== null,
  set: (open) => { if (!open) groupsOrg.value = null }
})

// The org's members, filtered here: the host-admin member list isn't searchable.
const searchOrgMembers = async (q: string): Promise<GroupsManagerUser[]> => {
  if (!groupsOrg.value) return []
  const res = await $fetch<{ members: { user_id: string, display_name: string, email: string | null, avatar: string | null }[] }, string>(
    `/api/admin/orgs/${groupsOrg.value.id}/members`
  )
  const needle = q.toLowerCase()
  return res.members
    .filter(m => m.display_name?.toLowerCase().includes(needle) || m.email?.toLowerCase().includes(needle))
    .slice(0, 50)
    .map(m => ({ id: m.user_id, display_name: m.display_name, email: m.email, avatar: m.avatar }))
}

const openDelete = (o: AdminOrg) => {
  deleteTarget.value = o
  deleteConfirm.value = ''
}

const handleDelete = async () => {
  const org = deleteTarget.value
  if (!org || deleteConfirm.value !== org.slug) return
  deleting.value = true
  try {
    await $fetch(`/api/admin/orgs/${org.id}`, { method: 'DELETE', body: { confirm: org.slug } })
    toast.add({ title: 'Organization deleted', description: org.name, color: 'success' })
    deleteTarget.value = null
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: 'Delete failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to delete organization',
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">
          Organizations
        </h1>
        <p class="text-sm text-(--ui-text-muted)">
          Every org in this deployment.
        </p>
      </div>
      <UButton
        to="/orgs/new"
        icon="i-lucide-plus"
      >
        Create org
      </UButton>
    </header>

    <div
      v-if="pending && orgs.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <ul
      v-else
      class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
    >
      <li
        v-for="o in orgs"
        :key="o.id"
        class="flex items-center justify-between gap-3 p-4"
      >
        <div class="min-w-0">
          <NuxtLink
            :to="`/@${o.slug}/dashboard`"
            class="font-medium hover:underline"
          >
            {{ o.name }}
          </NuxtLink>
          <div class="text-xs text-(--ui-text-muted)">
            /@{{ o.slug }} · {{ o.member_count }} member{{ o.member_count === 1 ? '' : 's' }} · {{ o.app_count }} app{{ o.app_count === 1 ? '' : 's' }}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <UBadge
            v-if="o.suspended"
            color="error"
            variant="subtle"
          >
            Suspended
          </UBadge>
          <UButton
            icon="i-lucide-users-round"
            variant="ghost"
            color="neutral"
            size="sm"
            :aria-label="`${o.name} groups`"
            @click="groupsOrg = o"
          />
          <UButton
            :to="`/@${o.slug}/settings`"
            icon="i-lucide-settings"
            variant="ghost"
            color="neutral"
            size="sm"
            :aria-label="`${o.name} settings`"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="sm"
            :aria-label="`Delete ${o.name}`"
            @click="openDelete(o)"
          />
        </div>
      </li>
    </ul>

    <USlideover
      v-model:open="groupsOpen"
      :title="groupsOrg ? `${groupsOrg.name} — groups` : ''"
      :ui="{ content: 'max-w-2xl' }"
    >
      <template #body>
        <GroupsManager
          v-if="groupsOrg"
          :api-base="`/api/admin/orgs/${groupsOrg.id}/groups`"
          :search-users="searchOrgMembers"
          mode-editable
        />
      </template>
    </USlideover>

    <UModal v-model:open="deleteModalOpen">
      <template #content>
        <form
          v-if="deleteTarget"
          class="p-6 space-y-4"
          @submit.prevent="handleDelete"
        >
          <h2 class="text-lg font-semibold">
            Delete {{ deleteTarget.name }}?
          </h2>
          <p class="text-sm">
            This is permanent. Every membership, role, app setting and record in
            this organization is deleted with it.
          </p>
          <UFormField :label="`Type ${deleteTarget.slug} to confirm`">
            <UInput
              v-model="deleteConfirm"
              autofocus
              autocomplete="off"
              :disabled="deleting"
            />
          </UFormField>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="deleteTarget = null"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              color="error"
              :loading="deleting"
              :disabled="deleteConfirm !== deleteTarget.slug"
            >
              Delete
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
