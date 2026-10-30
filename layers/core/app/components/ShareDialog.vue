<script setup lang="ts">
// Share a personal item. Talks to the routes an app mounts with
// `defineShareHandler` (core server/utils/shares.ts) at `endpoint`.
const props = defineProps<{
  endpoint: string
  title?: string
}>()
const open = defineModel<boolean>('open', { default: false })

type Role = 'viewer' | 'editor'

interface Person {
  id: string
  display_name: string
  avatar: string | null
}

interface ShareEntry {
  id: string
  role: Role
  user: Person | null
  pending: { email: string | null, expired: boolean } | null
}

interface ShareState {
  canManage: boolean
  owner: Person | null
  shares: ShareEntry[]
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Can view' },
  { value: 'editor', label: 'Can edit' }
]

const toast = useToast()
const { user } = useAuth()

const state = ref<ShareState | null>(null)
const people = ref<Person[]>([])
const loading = ref(false)
const busy = ref(false)

const mode = ref<'person' | 'email' | 'link'>('person')
const personId = ref<string | undefined>(undefined)
const email = ref('')
const role = ref<Role>('viewer')
const linkUrl = ref('')

function errorMessage(err: unknown): string | undefined {
  return (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage
}

const load = async () => {
  loading.value = true
  try {
    const [shares, known] = await Promise.all([
      $fetch<ShareState>(props.endpoint),
      $fetch<{ people: Person[] }>('/api/shares/people')
    ])
    state.value = shares
    people.value = known.people
    if (known.people.length === 0 && mode.value === 'person') mode.value = 'email'
  } catch (err: unknown) {
    toast.add({ title: 'Could not load sharing', description: errorMessage(err), color: 'error' })
  } finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (!v) return
  linkUrl.value = ''
  void load()
}, { immediate: true })

const sharedUserIds = computed(() => new Set((state.value?.shares ?? []).map(s => s.user?.id).filter(Boolean)))
const personItems = computed(() => people.value
  .filter(p => !sharedUserIds.value.has(p.id))
  .map(p => ({ value: p.id, label: p.display_name })))

const MODE_ITEMS = [
  { value: 'person', label: 'Someone I know' },
  { value: 'email', label: 'Email' },
  { value: 'link', label: 'Link' }
]

const canAdd = computed(() => {
  if (mode.value === 'person') return !!personId.value
  if (mode.value === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())
  return true
})

const onAdd = async () => {
  busy.value = true
  try {
    const body = mode.value === 'person'
      ? { userId: personId.value, role: role.value }
      : mode.value === 'email'
        ? { email: email.value.trim(), role: role.value }
        : { link: true, role: role.value }
    const res = await $fetch<{ id: string, url?: string }>(props.endpoint, { method: 'POST', body })
    if (mode.value === 'link' && res.url) linkUrl.value = res.url
    if (mode.value === 'email') toast.add({ title: 'Invite sent', color: 'success' })
    personId.value = undefined
    email.value = ''
    await load()
  } catch (err: unknown) {
    toast.add({ title: 'Share failed', description: errorMessage(err), color: 'error' })
  } finally {
    busy.value = false
  }
}

const onRole = async (share: ShareEntry, next: Role) => {
  try {
    await $fetch(`${props.endpoint}/${share.id}`, { method: 'PATCH', body: { role: next } })
    await load()
  } catch (err: unknown) {
    toast.add({ title: 'Update failed', description: errorMessage(err), color: 'error' })
  }
}

const onRemove = async (share: ShareEntry) => {
  try {
    await $fetch(`${props.endpoint}/${share.id}`, { method: 'DELETE' })
    if (share.user?.id === user.value?.id) {
      open.value = false
      return
    }
    await load()
  } catch (err: unknown) {
    toast.add({ title: 'Remove failed', description: errorMessage(err), color: 'error' })
  }
}

const onResend = async (share: ShareEntry) => {
  try {
    const res = await $fetch<{ url: string }>(`${props.endpoint}/${share.id}/resend`, { method: 'POST' })
    if (share.pending?.email) toast.add({ title: 'Invite sent again', color: 'success' })
    else linkUrl.value = res.url
    await load()
  } catch (err: unknown) {
    toast.add({ title: 'Resend failed', description: errorMessage(err), color: 'error' })
  }
}

const copyLink = async () => {
  await navigator.clipboard.writeText(linkUrl.value)
  toast.add({ title: 'Link copied', color: 'success' })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title ? `Share ${title}` : 'Share'"
  >
    <template #body>
      <div class="space-y-4">
        <div
          v-if="loading && !state"
          class="text-sm text-(--ui-text-muted)"
        >
          Loading...
        </div>

        <template v-else-if="state">
          <form
            v-if="state.canManage"
            class="space-y-3"
            @submit.prevent="onAdd"
          >
            <div class="flex items-center gap-1">
              <UTabs
                v-model="mode"
                :items="MODE_ITEMS"
                :content="false"
                size="xs"
                class="flex-1"
              />
              <InfoTip>
                <p>Share with someone you've shared with before, or send an email invite or a single-use link. Nothing reaches their account until they accept.</p>
                <p>Anything you share is deleted along with your account.</p>
              </InfoTip>
            </div>
            <div class="flex gap-2">
              <USelectMenu
                v-if="mode === 'person'"
                v-model="personId"
                :items="personItems"
                value-key="value"
                placeholder="Choose someone"
                class="flex-1"
              />
              <UInput
                v-else-if="mode === 'email'"
                v-model="email"
                type="email"
                placeholder="name@example.com"
                class="flex-1"
              />
              <div
                v-else
                class="flex-1 text-sm text-(--ui-text-muted) self-center"
              >
                Anyone who opens it while signed in
              </div>
              <USelect
                v-model="role"
                :items="ROLE_OPTIONS"
                class="w-32"
              />
              <UButton
                type="submit"
                :loading="busy"
                :disabled="!canAdd"
              >
                {{ mode === 'link' ? 'Create link' : 'Share' }}
              </UButton>
            </div>
            <div
              v-if="linkUrl"
              class="flex gap-2"
            >
              <UInput
                :model-value="linkUrl"
                readonly
                class="flex-1"
              />
              <UButton
                icon="i-lucide-copy"
                color="neutral"
                variant="outline"
                @click="copyLink"
              >
                Copy
              </UButton>
            </div>
          </form>

          <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
            <li
              v-if="state.owner"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="font-medium truncate">
                {{ state.owner.display_name }}
              </div>
              <span class="text-sm text-(--ui-text-muted)">Owner</span>
            </li>
            <li
              v-for="share in state.shares"
              :key="share.id"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ share.user?.display_name || share.pending?.email || 'Link invite' }}
                </div>
                <div
                  v-if="share.pending"
                  class="text-xs text-(--ui-text-muted)"
                >
                  {{ share.pending.expired ? 'Invite expired' : 'Invite pending' }}
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <UButton
                  v-if="state.canManage && share.pending"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  @click="onResend(share)"
                >
                  {{ share.pending.email ? 'Resend' : 'New link' }}
                </UButton>
                <USelect
                  v-if="state.canManage"
                  :model-value="share.role"
                  :items="ROLE_OPTIONS"
                  size="xs"
                  class="w-28"
                  @update:model-value="(v: string) => onRole(share, v as Role)"
                />
                <span
                  v-else
                  class="text-sm text-(--ui-text-muted)"
                >{{ share.role === 'editor' ? 'Can edit' : 'Can view' }}</span>
                <UButton
                  v-if="state.canManage || share.user?.id === user?.id"
                  size="xs"
                  color="error"
                  variant="ghost"
                  icon="i-lucide-x"
                  :aria-label="share.user?.id === user?.id ? 'Leave' : 'Remove'"
                  @click="onRemove(share)"
                />
              </div>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </UModal>
</template>
