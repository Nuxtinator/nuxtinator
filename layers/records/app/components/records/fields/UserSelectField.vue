<script setup lang="ts">
// Inline user picker: async search over the org user directory. A single
// field commits a user id (or null); a multiple field commits the full id
// array (the server replaces the list). A multiple field shows its users as
// removable avatar chips followed by a "+" that opens the picker; a single
// field's chip is itself the picker's trigger.
import type { AvatarProps } from '@nuxt/ui'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'
import type { RecordsUser } from '../../../composables/useRecordsUsers'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string[] | string | null]
}>()

const { users, byId, ensureUsers, searchUsers } = useRecordsUsers()

const searchTerm = ref('')
const results = ref<RecordsUser[]>([])

onMounted(async () => {
  try {
    await ensureUsers()
    results.value = users.value
  } catch {
    // An empty picker communicates the failure; commits validate server-side.
  }
})

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    try {
      results.value = await searchUsers(q)
    } catch {
      // Keep the previous results on a failed search.
    }
  }, 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const selectedIds = computed<string[]>(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.map(String)
  if (typeof props.modelValue === 'string' && props.modelValue !== '') return [props.modelValue]
  return []
})

interface UserItem {
  label: string
  value: string
  avatar?: AvatarProps
}

type SingleUserItem = Omit<UserItem, 'value'> & { value: string | null }

function toItem(u: RecordsUser): UserItem {
  return { label: u.name, value: u.id, avatar: userAvatarProps({ id: u.id, name: u.name, image: u.avatarUrl }) }
}

// Search results plus any current selections the search filtered out, so
// selected values always render with a label.
const items = computed<UserItem[]>(() => {
  const out = results.value.map(toItem)
  for (const id of selectedIds.value) {
    if (out.some(i => i.value === id)) continue
    const u = byId.value.get(id)
    out.push(u ? toItem(u) : { label: id, value: id })
  }
  return out
})

// Single optional fields get a leading "—" item that commits null.
const singleItems = computed<SingleUserItem[]>(() =>
  props.field.required ? items.value : [{ label: '—', value: null }, ...items.value]
)

const selectedUsers = computed(() =>
  selectedIds.value.map(id => byId.value.get(id) ?? { id, name: id, email: '', avatarUrl: null })
)

function onMultiple(value: string[]) {
  emit('commit', value)
}

function remove(id: string) {
  emit('commit', selectedIds.value.filter(v => v !== id))
}

function onSingle(value: string | null | undefined) {
  const next = typeof value === 'string' && value !== '' ? value : null
  if (next === (selectedIds.value[0] ?? null)) return
  emit('commit', next)
}
</script>

<template>
  <div
    v-if="field.multiple"
    class="flex flex-wrap items-center gap-1.5 min-h-8"
  >
    <UBadge
      v-for="user in selectedUsers"
      :key="user.id"
      color="neutral"
      variant="subtle"
    >
      <UAvatar
        v-bind="userAvatarProps({ id: user.id, name: user.name, image: user.avatarUrl })"
        size="3xs"
      />
      {{ user.name }}
      <button
        type="button"
        :aria-label="`Remove ${user.name}`"
        class="-me-0.5 rounded-sm text-(--ui-text-dimmed) hover:text-(--ui-text)"
        @click="remove(user.id)"
      >
        <UIcon
          name="i-lucide-x"
          class="size-3.5 block"
        />
      </button>
    </UBadge>
    <USelectMenu
      v-model:search-term="searchTerm"
      :model-value="selectedIds"
      :items="items"
      multiple
      ignore-filter
      value-key="value"
      label-key="label"
      variant="ghost"
      size="sm"
      trailing-icon=""
      :content="{ align: 'start' }"
      :aria-label="`Add to ${field.label}`"
      :class="{ '-ms-2.5': selectedUsers.length === 0 }"
      :ui="{ base: selectedUsers.length === 0 ? undefined : 'p-1.5', content: 'w-64' }"
      @update:model-value="onMultiple"
    >
      <UIcon
        name="i-lucide-plus"
        class="size-4 text-(--ui-text-dimmed)"
      />
      <span
        v-if="selectedUsers.length === 0"
        class="text-(--ui-text-dimmed)"
      >Add person</span>
    </USelectMenu>
  </div>
  <div
    v-else
    class="flex items-center min-h-8"
  >
    <USelectMenu
      v-model:search-term="searchTerm"
      :model-value="selectedIds[0] ?? null"
      :items="singleItems"
      ignore-filter
      value-key="value"
      label-key="label"
      variant="ghost"
      size="sm"
      trailing-icon=""
      :content="{ align: 'start' }"
      :ui="{ content: 'w-64' }"
      :aria-label="field.label"
      class="-ms-2.5"
      @update:model-value="onSingle"
    >
      <span
        v-if="selectedUsers[0]"
        class="flex items-center gap-1.5 min-w-0"
      >
        <UAvatar
          v-bind="userAvatarProps({ id: selectedUsers[0].id, name: selectedUsers[0].name, image: selectedUsers[0].avatarUrl })"
          size="2xs"
        />
        <span class="truncate">{{ selectedUsers[0].name }}</span>
      </span>
      <span
        v-else
        class="flex items-center gap-1.5 text-(--ui-text-dimmed)"
      >
        <UIcon
          name="i-lucide-plus"
          class="size-4"
        />
        Add person
      </span>
    </USelectMenu>
  </div>
</template>
