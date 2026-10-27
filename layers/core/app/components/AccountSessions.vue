<script setup lang="ts">
// Account row: how many devices are signed in to this account. Manage opens
// the device list, with sign-out per device and for every device but this one.
interface SessionRow {
  id: string
  client: 'web' | 'native'
  created_at: string
  last_used_at: string
  user_agent: string | null
  ip: string | null
  current: boolean
}

const toast = useToast()
const { data, refresh } = useLazyFetch<{ sessions: SessionRow[] }>('/api/auth/sessions', {
  key: 'auth-sessions',
  default: () => ({ sessions: [] })
})

const busy = ref<string | null>(null)
const { open, toggle } = useSettingsRow('sessions')

function describe(s: SessionRow): string {
  const ua = s.user_agent || ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : null
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null
  if (s.client === 'native') return os ? `App on ${os}` : 'App'
  return [browser, os].filter(Boolean).join(' on ') || 'Browser'
}

async function revoke(id: string) {
  busy.value = id
  try {
    await $fetch(`/api/auth/sessions/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (err: any) {
    toast.add({ title: err?.data?.statusMessage || 'Could not sign out that device', color: 'error' })
  } finally {
    busy.value = null
  }
}

async function revokeOthers() {
  busy.value = 'others'
  try {
    await $fetch('/api/auth/sessions', { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Signed out of other devices', color: 'success' })
  } catch (err: any) {
    toast.add({ title: err?.data?.statusMessage || 'Could not sign out other devices', color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <SettingsRow
    label="Devices"
    :value="data.sessions.length ? `${data.sessions.length} signed in` : undefined"
    :open="open"
  >
    <template #actions>
      <UButton
        color="neutral"
        variant="outline"
        @click="toggle"
      >
        {{ open ? 'Hide' : 'Manage' }}
      </UButton>
    </template>
    <template #panel>
      <div class="space-y-3">
        <ul class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) px-4">
          <li
            v-for="s in data.sessions"
            :key="s.id"
            class="flex items-center justify-between gap-4 py-3"
          >
            <div>
              <div class="font-medium">
                {{ describe(s) }}
                <UBadge
                  v-if="s.current"
                  color="success"
                  variant="subtle"
                  size="sm"
                  class="ml-2"
                >
                  This device
                </UBadge>
              </div>
              <div class="text-sm text-(--ui-text-muted)">
                Last active {{ new Date(s.last_used_at).toLocaleString() }}<span v-if="s.ip"> · {{ s.ip }}</span>
              </div>
            </div>
            <UButton
              v-if="!s.current"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="busy === s.id"
              @click="revoke(s.id)"
            >
              Sign out
            </UButton>
          </li>
        </ul>
        <UButton
          v-if="data.sessions.length > 1"
          color="neutral"
          variant="outline"
          :loading="busy === 'others'"
          @click="revokeOthers"
        >
          Sign out other devices
        </UButton>
      </div>
    </template>
  </SettingsRow>
</template>
