<script setup lang="ts">
import type { GroupsManagerUser } from '#core/app/components/GroupsManager.vue'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)

const searchUsers = async (q: string): Promise<GroupsManagerUser[]> => {
  const res = await $fetch<{ rows: { user_id: string, display_name: string, email: string | null }[] }, string>(
    `/api/o/${orgSlug.value}/members`,
    { query: { q, pageSize: 10, sort: 'display_name', dir: 'asc' } }
  )
  return res.rows.map(r => ({ id: r.user_id, display_name: r.display_name, email: r.email }))
}
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <GroupsManager
      :api-base="`/api/o/${orgSlug}/groups`"
      :search-users="searchUsers"
      mode-editable
    >
      <template #header>
        <header class="flex items-center gap-1">
          <h1 class="text-3xl font-bold">
            Groups
          </h1>
          <InfoTip>
            <p>Groups are named sets of this organization's members. List a group on an app's access, under Apps, to open the app only for its members.</p>
            <p>When groups run as teams, a project or portfolio can be limited to teams too.</p>
          </InfoTip>
        </header>
      </template>
    </GroupsManager>
  </div>
</template>
