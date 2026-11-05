<script setup lang="ts">
// Share management popover: who can open the view (everyone, its teams, or
// nobody else — the owner's call, saved as it changes) and the people it is
// shared with, at what level, picked from the org directory. A person's share
// applies whatever the view's visibility.
import type { ViewsShareEntry, ViewDetail, ViewsVisibility } from '../../utils/views-types'

const props = defineProps<{
  view: ViewDetail
}>()

const emit = defineEmits<{
  changed: []
}>()

const toast = useToast()
const { users, ensureUsers } = useRecordsUsers()

const open = ref(false)
const shares = ref<ViewsShareEntry[]>([])
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
    const res = await $fetch<{ items: ViewsShareEntry[] }>(`/api/views/${props.view.id}/shares`)
    shares.value = res.items
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to load shares') })
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
    await $fetch(`/api/views/${props.view.id}/shares`, {
      method: 'POST',
      body: { userId: newUserId.value, level: newLevel.value }
    })
    newUserId.value = undefined
    await load()
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to share the view') })
  } finally {
    busy.value = false
  }
}

async function setLevel(share: ViewsShareEntry, level: 'view' | 'edit') {
  if (share.level === level) return
  try {
    await $fetch(`/api/views/${props.view.id}/shares`, {
      method: 'POST',
      body: { userId: share.userId, level }
    })
    await load()
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to change the share') })
  }
}

async function removeShare(share: ViewsShareEntry) {
  try {
    await $fetch(`/api/views/${props.view.id}/shares/${share.userId}`, { method: 'DELETE' })
    await load()
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to remove the share') })
  }
}

const isOwner = computed(() => props.view.accessLevel === 'owner')

const visibility = ref<string>(props.view.visibility)
const teamIds = ref<string[]>(props.view.teams.map(t => t.id))
const savingAccess = ref(false)

function resetAccess() {
  visibility.value = props.view.visibility
  teamIds.value = props.view.teams.map(t => t.id)
}
watch(() => [props.view.visibility, props.view.teams], resetAccess)

function accessChanged(): boolean {
  if (visibility.value !== props.view.visibility) return true
  if (visibility.value !== 'teams') return false
  const saved = new Set(props.view.teams.map(t => t.id))
  return teamIds.value.length !== saved.size || teamIds.value.some(id => !saved.has(id))
}

async function saveAccess() {
  if (savingAccess.value || !accessChanged()) return
  savingAccess.value = true
  try {
    await $fetch(`/api/views/${props.view.id}`, {
      method: 'PATCH',
      body: {
        visibility: visibility.value as ViewsVisibility,
        teamIds: visibility.value === 'teams' ? teamIds.value : []
      }
    })
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to change who can open the view') })
    resetAccess()
  } finally {
    savingAccess.value = false
  }
}
watch([visibility, teamIds], saveAccess)
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

        <TeamAccessField
          v-model:visibility="visibility"
          v-model:team-ids="teamIds"
          app-id="views"
          none-value="private"
          :current-teams="view.teams"
          :disabled="!isOwner || savingAccess"
        />

        <USeparator label="People" />

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
