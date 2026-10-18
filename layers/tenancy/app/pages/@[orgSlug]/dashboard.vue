<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)

const { data: org, pending, error } = await useFetch<{
  id: string
  slug: string
  name: string
  member_count: number
  perms: string[]
}>(() => `/api/o/${orgSlug.value}`, {
  watch: [orgSlug],
  key: 'org-detail'
})

const { orgApps, personalApps } = await useApps()

const canManageSettings = computed(() => org.value?.perms?.includes('org.settings.write'))

// Server returns 423 for suspended orgs (from the tenancy middleware). Render
// a dedicated state rather than a generic error alert — gives the user a
// clear "this is the suspended page" experience.
const isSuspended = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 423)
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <div
      v-if="pending && !org"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <UCard
      v-else-if="isSuspended"
      :ui="{ body: 'p-8 text-center' }"
    >
      <UIcon
        name="i-lucide-pause-circle"
        class="size-12 text-(--ui-text-muted) mx-auto mb-4"
      />
      <h1 class="text-2xl font-bold mb-2">
        Organization suspended
      </h1>
      <p class="text-sm text-(--ui-text-muted) mb-6">
        This organization is currently suspended. Contact your administrator if you believe this is a mistake.
      </p>
      <UButton
        to="/orgs"
        variant="outline"
      >
        Back to organizations
      </UButton>
    </UCard>

    <UAlert
      v-else-if="error"
      color="error"
      :title="(error as { statusMessage?: string } | null)?.statusMessage || 'Failed to load organization'"
    />

    <template v-else-if="org">
      <header class="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 class="text-3xl font-bold">
            {{ org.name }}
          </h1>
          <p class="text-sm text-(--ui-text-muted)">
            /@{{ org.slug }}
          </p>
        </div>
        <UButton
          v-if="canManageSettings"
          :to="`/@${org.slug}/settings`"
          variant="outline"
          icon="i-lucide-settings"
        >
          Settings
        </UButton>
      </header>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">
          Apps
        </h2>
        <AppLauncherGrid
          :apps="orgApps"
          empty-text="No apps enabled for this organization."
        />
      </section>

      <section
        v-if="personalApps.length"
        class="space-y-3"
      >
        <h2 class="text-lg font-semibold">
          Personal
        </h2>
        <p class="text-sm text-(--ui-text-muted) -mt-2">
          Yours in every organization.
        </p>
        <AppLauncherGrid
          :apps="personalApps"
          empty-text=""
        />
      </section>
    </template>
  </div>
</template>
