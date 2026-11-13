<script setup lang="ts">
import type { GroupsManagerUser } from '#core/app/components/GroupsManager.vue'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)

const searchUsers = async (q: string): Promise<GroupsManagerUser[]> => {
  const res = await $fetch<{ users: GroupsManagerUser[] }, string>(
    `/api/o/${orgSlug.value}/groups/candidates`,
    { query: { q } }
  )
  return res.users
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
        <PageTitle title="Groups">
          <template #help>
            <p>Groups are named sets of this organization's members. List a group on an app's access, under Apps, to open the app only for its members.</p>
            <p>When groups run as teams, a project or portfolio can be limited to teams too.</p>
          </template>
        </PageTitle>
      </template>
    </GroupsManager>
  </div>
</template>
