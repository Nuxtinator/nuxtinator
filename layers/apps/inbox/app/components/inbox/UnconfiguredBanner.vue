<script setup lang="ts">
// Shown while the org has no shared contact address. Without one the send
// sweep cannot build a From identity, so replies are held in the queue rather
// than sent — this is the only place that state is visible, so it sits above
// both the conversation list and the thread. Admins get a link to the setting;
// everyone else is told who to ask.
defineProps<{ canManageSettings: boolean }>()

const inboxPath = useInboxPath()
</script>

<template>
  <UAlert
    icon="i-lucide-mail-warning"
    color="warning"
    variant="subtle"
    title="This inbox has no sending address"
    :description="canManageSettings
      ? 'Replies are held in the queue until a shared contact address is set. Nothing is lost — held replies send automatically once it is configured.'
      : 'Replies are held in the queue until an administrator sets a shared contact address. Nothing is lost — held replies send automatically once it is configured.'"
    class="rounded-none border-x-0 border-t-0"
  >
    <template v-if="canManageSettings" #actions>
      <UButton
        :to="inboxPath('/inbox/settings')"
        label="Open settings"
        icon="i-lucide-settings"
        size="xs"
        color="warning"
        variant="solid"
      />
    </template>
  </UAlert>
</template>
