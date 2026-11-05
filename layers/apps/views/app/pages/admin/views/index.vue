<script setup lang="ts">
// Admin governance: every view regardless of visibility, with delete and
// change-owner — the cleanup surface for junk views and departed owners.
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

interface AdminViewRow {
  id: string
  name: string
  recordTypeKey: string
  layout: string
  visibility: string
  ownerId: string
  ownerName: string
  shareCount: number
  updatedAt: string
}

const toast = useToast()
const { users, ensureUsers } = useRecordsUsers()

const items = ref<AdminViewRow[]>([])
const pending = ref(true)
const error = ref<string | null>(null)

async function refresh() {
  pending.value = true
  try {
    const res = await $fetch<{ items: AdminViewRow[] }>('/api/views/admin')
    items.value = res.items
    error.value = null
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to load views')
  } finally {
    pending.value = false
  }
}

onMounted(() => {
  refresh()
  ensureUsers().catch(() => {
    // The owner picker stays empty until the directory loads.
  })
})

// --- change owner -----------------------------------------------------------

const ownerTarget = ref<AdminViewRow | null>(null)
const newOwnerId = ref<string | undefined>(undefined)
const savingOwner = ref(false)

const ownerItems = computed(() =>
  users.value
    .filter(u => u.id !== ownerTarget.value?.ownerId)
    .map(u => ({ label: u.name, value: u.id })))

function openOwnerModal(row: AdminViewRow) {
  ownerTarget.value = row
  newOwnerId.value = undefined
}

async function submitOwner() {
  if (!ownerTarget.value || !newOwnerId.value || savingOwner.value) return
  savingOwner.value = true
  try {
    await $fetch(`/api/views/admin/${ownerTarget.value.id}/owner`, {
      method: 'PATCH',
      body: { userId: newOwnerId.value }
    })
    ownerTarget.value = null
    await refresh()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to change the owner') })
  } finally {
    savingOwner.value = false
  }
}

const ownerModalOpen = computed({
  get: () => ownerTarget.value !== null,
  set: (v) => {
    if (!v) ownerTarget.value = null
  }
})

// --- delete -----------------------------------------------------------------

const deleteTarget = ref<AdminViewRow | null>(null)
const deleting = ref(false)

async function submitDelete() {
  if (!deleteTarget.value || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/views/admin/${deleteTarget.value.id}`, { method: 'DELETE' })
    deleteTarget.value = null
    await refresh()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to delete the view') })
  } finally {
    deleting.value = false
  }
}

const deleteModalOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (v) => {
    if (!v) deleteTarget.value = null
  }
})

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-lg font-semibold">
        Views
      </h1>
      <p class="text-sm text-(--ui-text-muted)">
        Every view in this workspace, including private ones.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <div
      v-else
      class="rounded-lg border border-(--ui-border) bg-(--ui-bg) overflow-x-auto"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-(--ui-border) text-left">
            <th class="px-3 py-2 font-medium">
              Name
            </th>
            <th class="px-3 py-2 font-medium">
              Type
            </th>
            <th class="px-3 py-2 font-medium">
              Visibility
            </th>
            <th class="px-3 py-2 font-medium">
              Owner
            </th>
            <th class="px-3 py-2 font-medium">
              Shares
            </th>
            <th class="px-3 py-2 font-medium">
              Updated
            </th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr
            v-for="row in items"
            :key="row.id"
          >
            <td class="px-3 py-2 font-medium">
              {{ row.name }}
            </td>
            <td class="px-3 py-2 text-(--ui-text-muted)">
              {{ row.recordTypeKey }} · {{ row.layout }}
            </td>
            <td class="px-3 py-2 text-(--ui-text-muted)">
              {{ row.visibility }}
            </td>
            <td class="px-3 py-2 text-(--ui-text-muted)">
              {{ row.ownerName }}
            </td>
            <td class="px-3 py-2 text-(--ui-text-muted)">
              {{ row.shareCount }}
            </td>
            <td class="px-3 py-2 text-(--ui-text-muted)">
              {{ formatDate(row.updatedAt) }}
            </td>
            <td class="px-3 py-2">
              <div class="flex justify-end gap-1">
                <UButton
                  icon="i-lucide-user-round-cog"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  aria-label="Change owner"
                  @click="openOwnerModal(row)"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="error"
                  size="xs"
                  aria-label="Delete view"
                  @click="deleteTarget = row"
                />
              </div>
            </td>
          </tr>
          <tr v-if="items.length === 0 && !pending">
            <td
              colspan="7"
              class="px-3 py-8 text-center text-(--ui-text-muted)"
            >
              No views yet.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <UModal v-model:open="ownerModalOpen">
      <template #content>
        <form
          class="p-6 space-y-4"
          @submit.prevent="submitOwner"
        >
          <h2 class="text-lg font-semibold">
            Change owner of "{{ ownerTarget?.name }}"
          </h2>
          <USelectMenu
            v-model="newOwnerId"
            :items="ownerItems"
            value-key="value"
            label-key="label"
            placeholder="New owner…"
            class="w-full"
            :disabled="savingOwner"
          />
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="savingOwner"
              @click="ownerModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :loading="savingOwner"
              :disabled="!newOwnerId"
            >
              Change owner
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <UModal v-model:open="deleteModalOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Delete "{{ deleteTarget?.name }}"?
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            The view and its sharing settings will be removed for everyone.
            Records are not touched.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="deleting"
              @click="deleteModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="submitDelete"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
