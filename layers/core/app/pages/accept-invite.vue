<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

const router = useRouter()
const route = useRoute()
const { user, checkAuth } = useAuth()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))

const state = reactive({
  email: '',
  display_name: '',
  password: '',
  confirmPassword: ''
})

interface InviteInfo {
  kind: 'email' | 'link'
  email: string | null
  display_name: string
  inviter_name: string | null
  orgs: Array<{ slug: string, name: string }>
}

const info = ref<InviteInfo | null>(null)
const loading = ref(false)
const submitting = ref(false)
const error = ref(authErrorMessage(route.query.auth_error))
const verificationSent = ref(false)
const inviteState = ref<'loading' | 'valid' | 'invalid' | 'expired'>('loading')

const joiningWhat = computed(() => {
  const names = info.value?.orgs.map(o => o.name) ?? []
  return names.length ? names.join(', ') : 'this workspace'
})

onMounted(async () => {
  if (!token.value) {
    inviteState.value = 'invalid'
    return
  }
  loading.value = true
  try {
    const data = await $fetch<InviteInfo>('/api/auth/invite-info', { query: { token: token.value } })
    info.value = data
    state.email = data.email ?? ''
    state.display_name = data.display_name
    inviteState.value = 'valid'
  } catch (err: any) {
    inviteState.value = err?.statusCode === 410 ? 'expired' : 'invalid'
  } finally {
    loading.value = false
  }
})

const passwordMatch = computed(() => {
  if (!state.confirmPassword) return true
  return state.password === state.confirmPassword
})

async function handleAccept() {
  error.value = ''

  if (info.value?.kind === 'link' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) {
    error.value = 'Enter a valid email address'
    return
  }
  if (state.display_name.trim().length < 2) {
    error.value = 'Display name must be at least 2 characters'
    return
  }
  if (state.password.length < 8) {
    error.value = 'Password must be at least 8 characters'
    return
  }
  // Mismatch is surfaced inline under the confirm field; submit button is also
  // disabled in that state. Bail without surfacing a duplicate top-level alert.
  if (state.password !== state.confirmPassword) {
    return
  }

  submitting.value = true
  try {
    const res = await $fetch<{ success: boolean, redirect?: string, requiresVerification?: boolean }>('/api/auth/accept-invite', {
      method: 'POST',
      body: {
        token: token.value,
        password: state.password,
        display_name: state.display_name.trim(),
        ...(info.value?.kind === 'link' ? { email: state.email.trim().toLowerCase() } : {})
      }
    })
    if (res.requiresVerification) {
      verificationSent.value = true
      return
    }
    await checkAuth()
    // Server picks the right landing page (single-org → /@<slug>/dashboard, multi → /orgs).
    await navigateTo(res?.redirect || '/orgs', { replace: true })
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.data?.message || 'Failed to accept invitation. Please try again.'
  } finally {
    submitting.value = false
  }
}

// Signed in already: the invite is accepted into this account.
async function handleJoin() {
  error.value = ''
  submitting.value = true
  try {
    const res = await $fetch<{ success: boolean, redirect?: string }>('/api/auth/accept-invite', {
      method: 'POST',
      body: { token: token.value }
    })
    await navigateTo(res?.redirect || launcherPath(), { replace: true })
  } catch (err: any) {
    error.value = err?.data?.statusMessage || 'Failed to accept invitation. Please try again.'
  } finally {
    submitting.value = false
  }
}

async function useDifferentAccount() {
  await $fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  await checkAuth()
}
</script>

<template>
  <div>
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-2">
        Accept Invitation
      </h1>
      <p class="text-(--ui-text-muted)">
        Create your account, or join with one you already have
      </p>
    </div>

    <UCard :ui="{ body: 'p-6 sm:p-8' }">
      <div
        v-if="inviteState === 'loading'"
        class="flex items-center justify-center py-8"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-6 animate-spin text-(--ui-text-muted)"
        />
      </div>

      <div
        v-else-if="inviteState === 'invalid'"
        class="space-y-4"
      >
        <UAlert
          color="error"
          variant="soft"
          title="Invalid Invitation"
        />
        <p class="text-(--ui-text-muted)">
          This invitation link is invalid. Please ask your administrator for a new invite.
        </p>
        <UButton
          color="primary"
          size="lg"
          block
          @click="router.push('/login')"
        >
          Back to Login
        </UButton>
      </div>

      <div
        v-else-if="inviteState === 'expired'"
        class="space-y-4"
      >
        <UAlert
          color="error"
          variant="soft"
          title="Invitation Expired"
        />
        <p class="text-(--ui-text-muted)">
          This invitation has expired. Please ask your administrator to send a new invite.
        </p>
        <UButton
          color="primary"
          size="lg"
          block
          @click="router.push('/login')"
        >
          Back to Login
        </UButton>
      </div>

      <div
        v-else-if="verificationSent"
        class="space-y-4"
      >
        <UAlert
          color="success"
          variant="soft"
          title="Check your email"
          description="We sent a verification link to your address. Verify it, then sign in."
        />
        <UButton
          color="primary"
          size="lg"
          block
          @click="router.push('/login')"
        >
          Go to Sign In
        </UButton>
      </div>

      <div
        v-else-if="user"
        class="space-y-6"
      >
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
        />
        <p class="text-(--ui-text-muted)">
          <template v-if="info?.inviter_name">
            {{ info.inviter_name }} invited you to join
          </template>
          <template v-else>
            You've been invited to join
          </template>
          <strong>{{ joiningWhat }}</strong>.
        </p>
        <p class="text-(--ui-text-muted)">
          You're signed in as <strong>{{ user.email }}</strong>.
        </p>
        <UButton
          color="primary"
          size="lg"
          block
          :loading="submitting"
          @click="handleJoin"
        >
          Join as {{ user.email }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          size="lg"
          block
          :disabled="submitting"
          @click="useDifferentAccount"
        >
          Use a different account
        </UButton>
      </div>

      <form
        v-else
        class="space-y-6"
        @submit.prevent="handleAccept"
      >
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
          @close="error = ''"
        />

        <p
          v-if="info?.orgs.length"
          class="text-(--ui-text-muted)"
        >
          You've been invited to join <strong>{{ joiningWhat }}</strong>.
        </p>

        <AuthProviderButtons
          intent="login"
          :invite="token"
          separator="or create an account"
        />

        <UFormField
          label="Email"
          name="email"
          :required="info?.kind === 'link'"
        >
          <UInput
            v-model="state.email"
            type="email"
            size="lg"
            :disabled="info?.kind === 'email' || submitting"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Display Name"
          name="display_name"
          required
        >
          <UInput
            v-model="state.display_name"
            type="text"
            size="lg"
            :disabled="submitting"
            autocomplete="name"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Password"
          name="password"
          required
        >
          <UInput
            v-model="state.password"
            type="password"
            placeholder="At least 8 characters"
            size="lg"
            :disabled="submitting"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Confirm Password"
          name="confirmPassword"
          required
        >
          <UInput
            v-model="state.confirmPassword"
            type="password"
            size="lg"
            :disabled="submitting"
            autocomplete="new-password"
            :color="!passwordMatch ? 'error' : undefined"
            class="w-full"
          />
          <p
            v-if="!passwordMatch"
            class="text-xs text-red-600 mt-1"
          >
            Passwords do not match
          </p>
        </UFormField>

        <UButton
          type="submit"
          color="primary"
          size="lg"
          block
          :loading="submitting"
          :disabled="submitting || !state.password || !state.confirmPassword || !passwordMatch"
        >
          Create Account
        </UButton>

        <p class="text-center text-sm text-(--ui-text-muted)">
          Already have an account?
          <NuxtLink
            :to="`/login?redirect=${encodeURIComponent(route.fullPath)}`"
            class="underline"
          >
            Sign in
          </NuxtLink>
          to accept with it.
        </p>
      </form>
    </UCard>
  </div>
</template>
