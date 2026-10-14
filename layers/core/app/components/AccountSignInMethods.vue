<script setup lang="ts">
// Account card: the ways the user can sign in (password + each registered
// provider), with link / unlink. Hidden when no provider is registered, since
// the password card already covers that case.
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

// Provider flows started from here (link, or re-authentication) return to
// this page with `?link=<code>`.
onMounted(() => {
  const status = route.query.link
  if (status === 'success') toast.add({ title: 'Account linked', color: 'success' })
  else if (typeof status === 'string' && status) toast.add({ title: authErrorMessage(status), color: 'error' })
})

const unlinking = ref<string | null>(null)

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
  <UCard v-if="methods.providers.length">
    <template #header>
      <h2 class="text-xl font-semibold">
        Sign-in Methods
      </h2>
    </template>
    <ul class="divide-y divide-(--ui-border)">
      <li class="flex items-center justify-between gap-4 py-3 first:pt-0">
        <div class="flex items-center gap-3">
          <UIcon
            name="i-lucide-key-round"
            class="size-5"
          />
          <div>
            <div class="font-medium">
              Password
            </div>
            <div class="text-sm text-(--ui-text-muted)">
              {{ methods.password ? 'Set' : 'Not set' }}
            </div>
          </div>
        </div>
      </li>
      <li
        v-for="p in methods.providers"
        :key="p.id"
        class="flex items-center justify-between gap-4 py-3 last:pb-0"
      >
        <div class="flex items-center gap-3">
          <UIcon
            :name="p.icon"
            class="size-5"
          />
          <div>
            <div class="font-medium">
              {{ p.label }}
            </div>
            <div class="text-sm text-(--ui-text-muted)">
              {{ p.linked ? (p.linked.email || 'Linked') : 'Not linked' }}
            </div>
          </div>
        </div>
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
      </li>
    </ul>
  </UCard>
</template>
