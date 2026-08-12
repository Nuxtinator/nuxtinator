<script setup lang="ts">
// Share management popover: who has the view, at what level, plus adding
// people from the org directory. Shares only take effect while visibility
// isn't private — a private view surfaces that and offers the owner the
// one-click flip to 'shared'.
import type { WorkflowsShareEntry, WorkflowsViewDetail } from '../../utils/workflows-types'

const props = defineProps<{
  view: WorkflowsViewDetail
}>()

const emit = defineEmits<{
  changed: []
}>()

const toast = useToast()
const { users, ensureUsers } = useCrmUsers()

const open = ref(false)
const shares = ref<WorkflowsShareEntry[]>([])
const loading = ref(false)

const newUserId = ref<string | undefined>(undefined)
const newLevel = ref<'view' | 'edit'>('view')
const busy = ref(false)

const LEVEL_ITEMS = [
  { label: 'Can view', value: 'view' },
  { label: 'Can edit', value: 'edit' }
]

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ items: WorkflowsShareEntry[] }>(`/api/workflows/views/${props.view.id}/shares`)
    shares.value = res.items
  } catch (err) {
    toast.add({ color: 'error', title: crmErrorMessage(err, 'Failed to load shares') })
  } finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (!v) return
  newUserId.value = undefined
  newLevel.value = 'view'
  load()
  ensureUsers().catch(() => {
    // The picker stays empty; existing shares still list.
  })
})

const candidateItems = computed(() => {
  const taken = new Set([props.view.ownerId, ...shares.value.map(s => s.userId)])
  return users.value
    .filter(u => !taken.has(u.id))
    .map(u => ({ label: u.name, value: u.id }))
})

async function addShare() {
  if (!newUserId.value || busy.value) return
  busy.value = true
  try {
    await $fetch(`/api/workflows/views/${props.view.id}/shares`, {
      method: 'POST',
      body: { userId: newUserId.value, level: newLevel.value }
    })
    newUserId.value = undefined
    await load()
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: crmErrorMessage(err, 'Failed to share the view') })
  } finally {
    busy.value = false
  }
}

async function setLevel(share: WorkflowsShareEntry, level: 'view' | 'edit') {
  if (share.level === level) return
  try {
    await $fetch(`/api/workflows/views/${props.view.id}/shares`, {
      method: 'POST',
      body: { userId: share.userId, level }
    })
    await load()
  } catch (err) {
    toast.add({ color: 'error', title: crmErrorMessage(err, 'Failed to change the share') })
  }
}

async function removeShare(share: WorkflowsShareEntry) {
  try {
    await $fetch(`/api/workflows/views/${props.view.id}/shares/${share.userId}`, { method: 'DELETE' })
    await load()
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: crmErrorMessage(err, 'Failed to remove the share') })
  }
}

const isOwner = computed(() => props.view.accessLevel === 'owner')

async function makeShared() {
  try {
    await $fetch(`/api/workflows/views/${props.view.id}`, {
      method: 'PATCH',
      body: { visibility: 'shared' }
    })
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: crmErrorMessage(err, 'Failed to change visibility') })
  }
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      icon="i-lucide-users"
      variant="ghost"
      color="neutral"
      size="sm"
    >
      Share
    </UButton>

    <template #content>
      <div class="w-80 p-4 space-y-3">
        <h3 class="text-sm font-semibold">
          Share "{{ view.name }}"
        </h3>

        <UAlert
          v-if="view.visibility === 'private'"
          color="warning"
          variant="subtle"
          icon="i-lucide-lock"
          title="This view is private — shares apply once it isn't."
        >
          <template
            v-if="isOwner"
            #actions
          >
            <UButton
              size="xs"
              color="warning"
              variant="soft"
              @click="makeShared"
            >
              Make it shared
            </UButton>
          </template>
        </UAlert>

        <div class="flex items-center gap-2">
          <USelectMenu
            v-model="newUserId"
            :items="candidateItems"
            value-key="value"
            label-key="label"
            placeholder="Add a person…"
            class="flex-1"
            :disabled="busy"
          />
          <USelectMenu
            v-model="newLevel"
            :items="LEVEL_ITEMS"
            value-key="value"
            label-key="label"
            class="w-28"
            :disabled="busy"
          />
          <UButton
            icon="i-lucide-plus"
            size="sm"
            :loading="busy"
            :disabled="!newUserId"
            aria-label="Add share"
            @click="addShare"
          />
        </div>

        <ul
          v-if="shares.length > 0"
          class="divide-y divide-(--ui-border)"
        >
          <li
            v-for="share in shares"
            :key="share.userId"
            class="flex items-center gap-2 py-2"
          >
            <UAvatar
              :src="share.avatar || undefined"
              :alt="share.displayName"
              size="2xs"
            />
            <span class="flex-1 text-sm truncate">{{ share.displayName }}</span>
            <USelectMenu
              :model-value="share.level"
              :items="LEVEL_ITEMS"
              value-key="value"
              label-key="label"
              size="xs"
              class="w-26"
              @update:model-value="setLevel(share, $event as 'view' | 'edit')"
            />
            <UButton
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              size="xs"
              :aria-label="`Remove ${share.displayName}`"
              @click="removeShare(share)"
            />
          </li>
        </ul>

        <p
          v-else-if="!loading"
          class="text-xs text-(--ui-text-muted)"
        >
          Not shared with anyone yet.
        </p>
      </div>
    </template>
  </UPopover>
</template>
