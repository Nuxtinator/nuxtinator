<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)

interface StaticRole {
  key: string
  name: string
  description: string
  source: 'host' | 'app'
  permissions: string[]
}
interface CustomRole {
  id: string
  name: string
  description: string
  permissions: string[]
}

const { data: staticData } = await useFetch<{ roles: StaticRole[] }>(
  () => `/api/o/${orgSlug.value}/static-roles`,
  { watch: [orgSlug], default: () => ({ roles: [] }) }
)
const { data: customData, refresh: refreshCustom } = await useFetch<{ roles: CustomRole[] }>(
  () => `/api/o/${orgSlug.value}/roles`,
  { watch: [orgSlug], default: () => ({ roles: [] }) }
)

const staticRoles = computed(() => staticData.value?.roles ?? [])
const customRoles = computed(() => customData.value?.roles ?? [])

const toast = useToast()
const confirmAction = useConfirm()

const onDeleteCustom = async (r: CustomRole) => {
  if (!await confirmAction({
    title: `Delete custom role "${r.name}"?`,
    description: 'Members with this role lose its permissions on their next request.',
    confirmLabel: 'Delete'
  })) return
  try {
    await $fetch(`/api/o/${orgSlug.value}/roles/${r.id}`, { method: 'DELETE' })
    toast.add({ title: 'Role deleted', color: 'success' })
    await refreshCustom()
  } catch (err: unknown) {
    toast.add({
      title: 'Delete failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <div class="space-y-8">
      <header class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 class="text-3xl font-bold">
            Roles
          </h1>
          <p class="text-sm text-(--ui-text-muted)">
            Edit static-role overrides or create custom roles for this organization.
          </p>
        </div>
        <UButton
          :to="`/@${orgSlug}/settings/roles/new`"
          icon="i-lucide-plus"
        >
          New custom role
        </UButton>
      </header>

      <section class="space-y-3">
        <div class="flex items-end justify-between">
          <h2 class="text-lg font-semibold">
            Static roles
          </h2>
          <UButton
            variant="outline"
            :to="`/@${orgSlug}/settings/roles/static`"
            icon="i-lucide-sliders-horizontal"
            size="sm"
          >
            Edit overrides
          </UButton>
        </div>
        <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
          <li
            v-for="r in staticRoles"
            :key="r.key"
            class="flex items-center justify-between gap-3 p-3"
          >
            <div class="min-w-0">
              <div class="font-medium">
                {{ r.name }}
                <span class="text-xs text-(--ui-text-muted) ml-2">
                  ({{ r.source }})
                </span>
              </div>
              <div class="text-xs text-(--ui-text-muted) truncate">
                {{ r.description || '—' }} · {{ r.permissions.length }} permissions
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">
          Custom roles
        </h2>
        <div
          v-if="customRoles.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          No custom roles yet.
        </div>
        <ul
          v-else
          class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
        >
          <li
            v-for="r in customRoles"
            :key="r.id"
            class="flex items-center justify-between gap-3 p-3"
          >
            <NuxtLink
              :to="`/@${orgSlug}/settings/roles/${r.id}`"
              class="min-w-0 flex-1 hover:underline"
            >
              <div class="font-medium">
                {{ r.name }}
              </div>
              <div class="text-xs text-(--ui-text-muted) truncate">
                {{ r.description || '—' }} · {{ r.permissions.length }} permissions
              </div>
            </NuxtLink>
            <UButton
              variant="ghost"
              color="error"
              icon="i-lucide-trash-2"
              size="sm"
              @click="onDeleteCustom(r)"
            />
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
