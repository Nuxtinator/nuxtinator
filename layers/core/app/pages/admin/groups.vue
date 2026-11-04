<script setup lang="ts">
import type { GroupsManagerUser } from '../../components/GroupsManager.vue'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const tenancyOn = !!useRuntimeConfig().public.tenancy

const searchUsers = async (q: string): Promise<GroupsManagerUser[]> => {
  const res = await $fetch<{ rows: GroupsManagerUser[] }>('/api/admin/users', { query: { q, pageSize: 10, sort: 'display_name', dir: 'asc' } })
  return res.rows
}
</script>

<template>
  <GroupsManager
    api-base="/api/admin/groups"
    :search-users="searchUsers"
  >
    <template #header="{ mode }">
      <header class="flex items-center gap-1">
        <h1 class="text-2xl font-bold">
          Groups
        </h1>
        <InfoTip>
          <p v-if="tenancyOn">
            Groups are named sets of users. List a group on a personal app's access to open the app for its members.
          </p>
          <p v-else>
            Groups are named sets of users. List a group on an app's access to open the app only for its members.
          </p>
          <p v-if="mode === 'teams'">
            Groups run as teams: members see the group and each other, and content can be limited to them. Change this under Settings.
          </p>
          <p v-else>
            Groups run as audiences: members don't see the group's other members. Change this under Settings.
          </p>
        </InfoTip>
      </header>
    </template>
  </GroupsManager>
</template>
