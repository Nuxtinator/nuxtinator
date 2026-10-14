<script setup lang="ts">
// Prompt shown by `useReauth().withReauth` when the server asks the user to
// confirm who they are before a sensitive action. Also reports the outcome of
// provider flows (re-authentication, linking) that return with `?link=<code>`.
const { open, settle } = useReauth()
const route = useRoute()
const toast = useToast()

onMounted(() => {
  const status = route.query.link
  if (typeof status !== 'string' || !status) return
  if (status === 'success') toast.add({ title: 'Account linked', color: 'success' })
  else toast.add({ title: authErrorMessage(status), color: 'error' })
  clearQueryParam('link')
})

interface Methods {
  password: boolean
  providers: Array<{ id: string, label: string, icon: string, startPath: string, linked: { email: string | null } | null }>
}

const { data: methods, refresh } = useLazyFetch<Methods>('/api/auth/methods', {
  key: 'auth-methods-reauth',
  default: () => ({ password: false, providers: [] })
})

const linkedProviders = computed(() => methods.value.providers.filter((p: Methods['providers'][number]) => p.linked))

function reauthUrl(startPath: string): string {
  const params = new URLSearchParams({ intent: 'reauth', redirect: route.fullPath })
  return `${startPath}?${params.toString()}`
}

const password = ref('')
const loading = ref(false)
const error = ref('')

watch(open, (v) => {
  if (v) {
    password.value = ''
    error.value = ''
    refresh()
  }
})

async function confirmPassword() {
  error.value = ''
  loading.value = true
  try {
    await $fetch('/api/auth/reauth', { method: 'POST', body: { password: password.value } })
    settle(true)
  } catch (err: any) {
    error.value = err?.data?.statusMessage || 'Could not confirm your password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    title="Confirm it's you"
    description="For your security, confirm your identity to continue."
    @update:open="(v: boolean) => { if (!v) settle(false) }"
  >
    <template #body>
      <div class="space-y-4">
        <form
          v-if="methods.password"
          class="space-y-4"
          @submit.prevent="confirmPassword"
        >
          <UFormField label="Password">
            <UInput
              v-model="password"
              type="password"
              size="lg"
              autocomplete="current-password"
              class="w-full"
              :disabled="loading"
            />
          </UFormField>
          <UAlert
            v-if="error"
            color="error"
            variant="soft"
            :title="error"
          />
          <UButton
            type="submit"
            size="lg"
            block
            :loading="loading"
            :disabled="!password || loading"
          >
            Confirm
          </UButton>
        </form>

        <UButton
          v-for="p in linkedProviders"
          :key="p.id"
          :to="reauthUrl(p.startPath)"
          external
          color="neutral"
          variant="outline"
          size="lg"
          block
          :icon="p.icon"
        >
          Continue with {{ p.label }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
