<script setup lang="ts">
/**
 * /oauth/continue — resumes an authorization request as a full page load.
 *
 * `/oauth/authorize` is a server route, so the SPA can't navigate to it: the
 * login page's client-side redirect would hit the router (and the tenancy
 * guard's org prefix) instead. Authorize sends logins through here, and this
 * page reloads `to` for real.
 */
// `tenantExempt` keeps the tenancy route guard from rewriting this naive path
// to `/@<org-slug>/...` — the page runs before any org is chosen.
definePageMeta({ layout: false, tenantExempt: true })

const route = useRoute()
const status = ref<'working' | 'error'>('working')
const message = ref('Continuing…')

// Only an authorization request on this origin may be resumed.
const to = String(route.query.to || '')
const valid = to.startsWith('/oauth/authorize?')

function resume() {
  window.location.replace(to)
}

onMounted(() => {
  if (!valid) {
    status.value = 'error'
    message.value = 'Missing or invalid authorization request.'
    return
  }
  resume()
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
