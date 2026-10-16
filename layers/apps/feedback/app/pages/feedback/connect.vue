<script setup lang="ts">
/**
 * /feedback/connect — sign-in bridge for the embeddable widget.
 *
 * The widget (on a third-party site) full-page-redirects here with the project,
 * its redirect_uri, a `state`, and a PKCE `code_challenge`. This page runs on
 * the host origin, so the host session cookie is available:
 *   - Not signed in → bounce through the host login and return here.
 *   - Signed in → ask the user to approve signing in to that project from that
 *     site. On approval, POST /api/v1/feedback/authorize (same-origin) and
 *     redirect the one-time code back to the embedding site, where the widget
 *     exchanges it for a token. Nothing is issued without the click.
 *
 * Public page — it handles its own auth bounce rather than relying on the auth
 * middleware (which wouldn't preserve these query params through login).
 * Framing is blocked by a routeRule so the approval can't be clickjacked.
 */
// `tenantExempt` keeps the tenancy route guard from rewriting this naive path
// to `/@<org-slug>/...` or bouncing it to /orgs — this bridge owns no org
// context and handles its own login bounce.
definePageMeta({ layout: 'auth', tenantExempt: true })

const route = useRoute()
const status = ref<'loading' | 'consent' | 'working' | 'cancelled' | 'error'>('loading')
const message = ref('')
const projectName = ref('')
const userEmail = ref('')

const projectId = String(route.query.project_id || '')
const redirectUri = String(route.query.redirect_uri || '')
const state = String(route.query.state || '')
const codeChallenge = String(route.query.code_challenge || '')

const siteOrigin = (() => {
  try {
    return new URL(redirectUri).origin
  } catch {
    return ''
  }
})()

function statusOf(e: any): number | undefined {
  return e?.statusCode ?? e?.status ?? e?.response?.status
}

function fail(text: string) {
  status.value = 'error'
  message.value = text
}

async function goToLogin() {
  const qs = new URLSearchParams(route.query as Record<string, string>).toString()
  await navigateTo(`/login?redirect=${encodeURIComponent(`/feedback/connect?${qs}`)}`)
}

onMounted(async () => {
  if (!projectId || !siteOrigin || !codeChallenge) return fail('Missing sign-in parameters.')

  try {
    const me = await $fetch<{ user: { email: string } }>('/api/auth/me')
    userEmail.value = me.user.email
  } catch (e) {
    if (statusOf(e) === 401) return await goToLogin()
    return fail('Could not check your sign-in.')
  }

  try {
    const project = await $fetch<{ name: string }>(`/api/v1/project/${encodeURIComponent(projectId)}`)
    projectName.value = project.name
  } catch {
    return fail('Unknown feedback project.')
  }

  status.value = 'consent'
})

async function allow() {
  status.value = 'working'
  try {
    const { code } = await $fetch<{ code: string }>('/api/v1/feedback/authorize', {
      method: 'POST',
      body: { project_id: projectId, redirect_uri: redirectUri, code_challenge: codeChallenge }
    })
    // Hand the code back on widget-namespaced params (`fw_*`) so they can't
    // collide with — or get stripped from — params the embedding page uses for
    // its own purposes (e.g. its own OAuth callback's `?code`/`?state`).
    const back = new URL(redirectUri)
    back.searchParams.set('fw_code', code)
    if (state) back.searchParams.set('fw_state', state)
    window.location.replace(back.toString())
  } catch (e: any) {
    if (statusOf(e) === 401) return await goToLogin()
    fail(e?.data?.statusMessage || 'Could not start sign-in for this site.')
  }
}
</script>

<template>
  <div>
    <p
      v-if="status === 'loading'"
      class="text-center text-(--ui-text-muted)"
    >
      Checking…
    </p>

    <UCard
      v-else-if="status === 'consent' || status === 'working'"
      :ui="{ body: 'p-6 sm:p-8' }"
    >
      <div class="space-y-6">
        <div class="space-y-2">
          <h1 class="text-xl font-semibold text-(--ui-text-highlighted)">
            Sign in to the feedback widget?
          </h1>
          <p class="text-(--ui-text-muted)">
            <span class="font-medium text-(--ui-text)">{{ siteOrigin }}</span>
            wants to send feedback to
            <span class="font-medium text-(--ui-text)">{{ projectName }}</span>
            as <span class="font-medium text-(--ui-text)">{{ userEmail }}</span>.
          </p>
          <p class="text-sm text-(--ui-text-muted)">
            The site will be able to see your name and email, submit feedback in your name, and see the feedback you've sent to this project. Only continue if you opened the widget on this site yourself.
          </p>
        </div>
        <div class="flex gap-3">
          <UButton
            color="neutral"
            variant="outline"
            size="lg"
            block
            :disabled="status === 'working'"
            @click="status = 'cancelled'"
          >
            Cancel
          </UButton>
          <UButton
            color="primary"
            size="lg"
            block
            :loading="status === 'working'"
            @click="allow"
          >
            Allow
          </UButton>
        </div>
      </div>
    </UCard>

    <div
      v-else
      class="space-y-2 text-center"
    >
      <p
        class="font-semibold"
        :class="status === 'error' ? 'text-(--ui-error)' : 'text-(--ui-text-highlighted)'"
      >
        {{ status === 'error' ? 'Sign-in failed' : 'Sign-in cancelled' }}
      </p>
      <p class="text-sm text-(--ui-text-muted)">
        {{ status === 'error' ? message : 'Nothing was shared. You can close this tab.' }}
      </p>
    </div>
  </div>
</template>
