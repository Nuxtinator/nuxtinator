<script setup lang="ts">
/**
 * /oauth/continue — resumes an authorization request as a full page load.
 *
 * `/oauth/authorize` is a server route, so the SPA can't navigate to it: the
 * login page's client-side redirect would hit the router (and the tenancy
 * guard's org prefix) instead. Authorize sends logins through here, and this
 * page reloads `to` for real.
 *
 * With `pick_org=1` (authorize couldn't tell which org to act in: the user
 * belongs to several and none is active) the user picks one first; it becomes
 * the `active-org-slug` cookie authorize resolves the org from.
 */
// `tenantExempt` keeps the tenancy route guard from rewriting this naive path
// to `/@<org-slug>/...` — the page runs before any org is chosen.
definePageMeta({ layout: false, tenantExempt: true })

interface OrgRow {
  slug: string
  name: string
  suspended: boolean
}

const route = useRoute()
const status = ref<'working' | 'pick' | 'error'>('working')
const message = ref('Continuing…')
const orgs = ref<OrgRow[]>([])

// Only an authorization request on this origin may be resumed.
const to = String(route.query.to || '')
const valid = to.startsWith('/oauth/authorize?')

function resume() {
  window.location.replace(to)
}

function choose(slug: string) {
  useCookie(`${useRuntimeConfig().public.cookiePrefix || ''}active-org-slug`, { maxAge: 60 * 60 * 24 * 30, sameSite: 'lax', path: '/' }).value = slug
  resume()
}

onMounted(async () => {
  if (!valid) {
    status.value = 'error'
    message.value = 'Missing or invalid authorization request.'
    return
  }
  if (route.query.pick_org !== '1') {
    resume()
    return
  }
  try {
    const res = await $fetch<{ orgs: OrgRow[] }>('/api/orgs')
    orgs.value = res.orgs.filter(o => !o.suspended)
    if (!orgs.value.length) {
      status.value = 'error'
      message.value = 'You are not a member of any active organization.'
      return
    }
    status.value = 'pick'
  } catch (e: any) {
    const code = e?.statusCode ?? e?.status ?? e?.response?.status
    if (code === 401) {
      await navigateTo(`/login?redirect=${encodeURIComponent(route.fullPath)}`)
      return
    }
    status.value = 'error'
    message.value = e?.data?.statusMessage || 'Could not load your organizations.'
  }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <p
      v-if="status === 'working'"
      class="text-(--ui-text-muted)"
    >
      {{ message }}
    </p>
    <div
      v-else-if="status === 'pick'"
      class="w-full max-w-sm space-y-4"
    >
      <div class="text-center space-y-1">
        <h1 class="text-lg font-semibold">
          Choose an organization
        </h1>
        <p class="text-sm text-(--ui-text-muted)">
          You belong to several. Pick the one to approve this sign-in in.
        </p>
      </div>
      <div class="space-y-2">
        <UButton
          v-for="org in orgs"
          :key="org.slug"
          :label="org.name"
          color="neutral"
          variant="outline"
          block
          size="lg"
          @click="choose(org.slug)"
        />
      </div>
    </div>
    <div
      v-else
      class="text-center space-y-2"
    >
      <p class="font-semibold text-(--ui-error)">
        Sign-in failed
      </p>
      <p class="text-sm text-(--ui-text-muted)">
        {{ message }}
      </p>
    </div>
  </div>
</template>
