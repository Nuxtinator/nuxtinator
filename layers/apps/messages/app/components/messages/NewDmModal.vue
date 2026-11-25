<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  created: [conversationId: string]
}>()

interface OrgUser {
  id: string
  display_name: string
  avatar: string
}

const query = ref('')
const results = ref<OrgUser[]>([])
const selected = ref<OrgUser[]>([])
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

let searchAbort: AbortController | null = null

watch(open, (v) => {
  if (v) {
    query.value = ''
    results.value = []
    selected.value = []
    errorMsg.value = null
    runSearch()
  }
})

watch(query, () => {
  runSearch()
})

async function runSearch() {
  searchAbort?.abort()
  searchAbort = new AbortController()
  try {
    const res = await $fetch<{ users: OrgUser[] }>('/api/messages/org-users', {
      query: { q: query.value },
      signal: searchAbort.signal
    })
    results.value = res.users
  } catch {
    // ignore aborts
  }
}

function toggle(u: OrgUser) {
  const idx = selected.value.findIndex(s => s.id === u.id)
  if (idx >= 0) selected.value.splice(idx, 1)
  else selected.value.push(u)
}

function isSelected(u: OrgUser): boolean {
  return selected.value.some(s => s.id === u.id)
}

async function submit() {
  if (selected.value.length === 0) return
  submitting.value = true
  errorMsg.value = null
  try {
    const res = await $fetch<{ id: string }>('/api/messages/conversations/dms', {
      method: 'POST',
      body: { userIds: selected.value.map(u => u.id) }
    })
    emit('created', res.id)
  } catch (e) {
    errorMsg.value = (e as { statusMessage?: string }).statusMessage ?? 'Failed to start DM.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="New direct message" :ui="{ content: 'max-w-md' }">
    <template #body>
      <div class="flex flex-col gap-3">
        <UInput v-model="query" placeholder="Search people..." icon="i-lucide-search" />
        <div v-if="selected.length" class="flex flex-wrap gap-1">
          <UBadge
            v-for="u in selected"
            :key="u.id"
            color="primary"
            variant="soft"
            class="cursor-pointer"
            @click="toggle(u)"
          >
            {{ u.display_name }}
            <UIcon name="i-lucide-x" class="size-3 ml-1" />
          </UBadge>
        </div>
        <ul class="flex flex-col gap-0.5 max-h-72 overflow-y-auto border border-(--ui-border) rounded-md">
          <li v-for="u in results" :key="u.id">
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated) text-left"
              :class="{ 'bg-(--ui-bg-elevated)': isSelected(u) }"
              @click="toggle(u)"
            >
              <UAvatar v-bind="userAvatarProps({ id: u.id, name: u.display_name, image: u.avatar })" size="sm" />
              <span class="text-sm flex-1 truncate">{{ u.display_name }}</span>
              <UIcon
                v-if="isSelected(u)"
                name="i-lucide-check"
                class="size-4 text-(--ui-primary)"
              />
            </button>
          </li>
          <li v-if="results.length === 0" class="px-3 py-4 text-sm text-(--ui-text-muted) text-center">
            No matches.
          </li>
        </ul>
        <p v-if="errorMsg" class="text-xs text-(--ui-error)">
          {{ errorMsg }}
        </p>
        <div class="flex justify-end gap-2 mt-2">
          <UButton variant="ghost" color="neutral" :disabled="submitting" @click="open = false">
            Cancel
          </UButton>
          <UButton :loading="submitting" :disabled="selected.length === 0" @click="submit">
            Start DM
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
