<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const { user } = useAuth()
const { orgs, pending, refresh } = await useUserOrgs()

const isOperatorAdmin = computed(() => !!(user.value as { is_admin?: boolean } | null)?.is_admin)

const statusLabel = (org: { suspended: boolean }) => org.suspended ? 'Suspended' : 'Active'
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <header class="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-3xl font-bold">
          Organizations
        </h1>
        <p class="text-sm text-(--ui-text-muted) mt-1">
          Pick an organization to work in.
        </p>
      </div>
      <UButton
        v-if="isOperatorAdmin"
        to="/orgs/new"
        icon="i-lucide-plus"
        size="md"
      >
        Create organization
      </UButton>
    </header>

    <div
      v-if="pending && orgs.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <UCard v-else-if="orgs.length === 0">
      <div class="space-y-3 text-sm">
        <p class="font-medium">
          You don't belong to any organizations yet.
        </p>
        <p class="text-(--ui-text-muted)">
          Ask your administrator to invite you, or create one if you have the permission.
        </p>
        <UButton
          v-if="isOperatorAdmin"
          to="/orgs/new"
          variant="outline"
          icon="i-lucide-plus"
        >
          Create your first organization
        </UButton>
      </div>
    </UCard>

    <ul
      v-else
      class="space-y-3"
    >
      <li
        v-for="org in orgs"
        :key="org.id"
        class="flex items-center gap-2 rounded-md border border-(--ui-border) dark:border-(--ui-border-accented) p-2 pr-3 bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated) transition-colors"
      >
        <NuxtLink
          :to="`/@${org.slug}/dashboard`"
          class="flex-1 min-w-0 flex items-center justify-between gap-3 p-2 rounded-md"
        >
          <div class="min-w-0">
            <div class="font-semibold truncate">
              {{ org.name }}
            </div>
            <div class="text-xs text-(--ui-text-muted) truncate">
              /@{{ org.slug }} · roles: {{ org.roles.join(', ') || 'none' }}
            </div>
          </div>
          <UBadge
            :color="org.suspended ? 'error' : 'neutral'"
            variant="subtle"
            size="sm"
          >
            {{ statusLabel(org) }}
          </UBadge>
        </NuxtLink>
        <UButton
          :to="`/@${org.slug}/settings`"
          icon="i-lucide-settings"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Org settings"
        />
      </li>
    </ul>

    <div class="text-xs text-(--ui-text-muted) pt-4">
      <button
        type="button"
        class="underline hover:text-(--ui-text)"
        @click="refresh()"
      >
        Refresh list
      </button>
    </div>
  </div>
</template>
