<script setup lang="ts">
// Shown while no domain can receive mail for this org's inbox. Without one
// the send sweep holds replies in the queue rather than sending them — this is
// the only place that state is visible, so it sits above both the
// conversation list and the thread. Host admins get a link to the mail setup;
// everyone else is told who to ask.
defineProps<{ isHostAdmin: boolean }>()
</script>

<template>
  <UAlert
    icon="i-lucide-mail-warning"
    color="warning"
    variant="subtle"
    title="No domain can receive mail yet"
    :description="isHostAdmin
      ? 'Replies are held in the queue until a mail domain can receive mail. Nothing is lost — held replies send automatically once one can.'
      : 'Replies are held in the queue until a host administrator sets up a mail domain that can receive mail. Nothing is lost — held replies send automatically once one can.'"
    class="rounded-none border-x-0 border-t-0"
  >
    <template v-if="isHostAdmin" #actions>
      <UButton
        to="/admin/email"
        label="Set up email"
        icon="i-lucide-mail"
        size="xs"
        color="warning"
        variant="solid"
      />
    </template>
  </UAlert>
</template>
