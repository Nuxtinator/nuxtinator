<script setup lang="ts">
// Account rows: one per registered sign-in provider, with link / unlink.
// Renders nothing when no provider is registered.
interface Methods {
  password: boolean
  count: number
  providers: Array<{
    id: string
    label: string
    icon: string
    startPath: string
    linked: { email: string | null } | null
  }>
}

const toast = useToast()
const route = useRoute()
const { withReauth } = useReauth()

const { data: methods, refresh } = useLazyFetch<Methods>('/api/auth/methods', {
  key: 'auth-methods',
  default: () => ({ password: false, count: 0, providers: [] })
})

const unlinking = ref<string | null>(null)

// The link flow returns to this page with `?link=<code>`, which ReauthModal reports.
function linkUrl(p: Methods['providers'][number]): string {
  const params = new URLSearchParams({ intent: 'link', redirect: route.path })
  return `${p.startPath}?${params.toString()}`
}

async function unlink(id: string) {
  unlinking.value = id
  try {
    await withReauth(() => $fetch(`/api/auth/methods/${id}`, { method: 'DELETE' }))
    toast.add({ title: 'Unlinked', color: 'success' })
    await refresh()
  } catch (err: any) {
    toast.add({ title: err?.data?.statusMessage || 'Could not unlink', color: 'error' })
  } finally {
    unlinking.value = null
  }
}
</script>

<template>
  <AccountRow
    v-for="p in methods.providers"
    :key="p.id"
    :label="p.label"
    :value="p.linked ? (p.linked.email || 'Linked') : 'Not linked'"
  >
    <template #leading>
      <UIcon
        :name="p.icon"
        class="size-5"
      />
    </template>
    <template #actions>
      <UButton
        v-if="p.linked"
        color="neutral"
        variant="outline"
        :loading="unlinking === p.id"
        :disabled="methods.count <= 1"
        @click="unlink(p.id)"
      >
        Unlink
      </UButton>
      <UButton
        v-else
        color="neutral"
        variant="outline"
        :to="linkUrl(p)"
        external
      >
        Link
      </UButton>
    </template>
  </AccountRow>
</template>
