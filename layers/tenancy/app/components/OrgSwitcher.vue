<script setup lang="ts">
const { orgs, pending } = await useUserOrgs()
const { slug } = useActiveOrg()
const route = useRoute()
const open = ref(false)

const activeOrg = computed(() => orgs.value.find(o => o.slug === slug.value) ?? null)

// When the user is on `/@<current>/<section>/...`, switching to another org
// should land on `/@<next>/<section>` so they stay in the same app/section.
// We only preserve the first segment (the app or "settings") — anything deeper
// is org-scoped data that doesn't exist in the target org (mail accountId,
// thread id, etc.). The user re-navigates from the section root.
//
// If the current path isn't org-scoped, fall back to the new org's launcher.
function pathForOrg(targetSlug: string): string {
  const m = route.path.match(/^\/@[^/]+(?:\/(.*))?$/)
  if (!m) return `/@${targetSlug}/dashboard`
  const rest = (m[1] || '').replace(/\/+$/, '')
  if (!rest) return `/@${targetSlug}/dashboard`
  const firstSeg = rest.split('/')[0]!
  return `/@${targetSlug}/${firstSeg}`
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :ui="{ content: 'w-72' }"
  >
    <UButton
      variant="ghost"
      color="neutral"
      size="sm"
      class="max-w-[12rem]"
      :aria-label="activeOrg ? `Active organization: ${activeOrg.name}` : 'Choose organization'"
    >
      <span class="truncate text-sm">
        {{ activeOrg?.name || 'Choose organization' }}
      </span>
      <UIcon
        name="i-lucide-chevron-down"
        class="size-4 ml-1 shrink-0 text-(--ui-text-muted)"
      />
    </UButton>

    <template #content>
      <div class="p-3">
        <p class="text-xs font-semibold uppercase tracking-wider text-(--ui-text-muted) px-1 pb-2">
          Organizations
        </p>

        <div
          v-if="pending && orgs.length === 0"
          class="px-2 py-6 text-center text-sm text-(--ui-text-muted)"
        >
          Loading...
        </div>

        <div
          v-else-if="orgs.length === 0"
          class="px-2 py-6 text-center text-sm text-(--ui-text-muted)"
        >
          You don't belong to any organizations yet.
        </div>

        <ul
          v-else
          class="flex flex-col gap-1"
        >
          <li
            v-for="org in orgs"
            :key="org.id"
          >
            <NuxtLink
              :to="pathForOrg(org.slug)"
              class="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-(--ui-bg-accented) transition-colors"
              :class="{ 'bg-(--ui-bg-accented)': org.slug === slug }"
              @click="open = false"
            >
              <div class="min-w-0">
                <div class="text-sm text-(--ui-text) truncate">
                  {{ org.name }}
                </div>
                <div class="text-xs text-(--ui-text-muted) truncate">
                  /@{{ org.slug }}
                </div>
              </div>
              <UIcon
                v-if="org.slug === slug"
                name="i-lucide-check"
                class="size-4 text-(--ui-text)"
              />
              <UIcon
                v-else-if="org.suspended"
                name="i-lucide-pause"
                class="size-4 text-(--ui-text-muted)"
              />
            </NuxtLink>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
</template>
