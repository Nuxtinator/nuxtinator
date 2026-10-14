<script setup lang="ts">
// Account card: the signed-in user's email and when the account was created.
const { user } = useAuth()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        Account Information
      </h2>
    </template>
    <div class="space-y-2 text-sm">
      <div>
        <span class="font-medium">Email:</span>
        <span class="ml-2 text-(--ui-text-muted)">{{ user?.email }}</span>
      </div>
      <div>
        <span class="font-medium">Account created:</span>
        <span class="ml-2 text-(--ui-text-muted)">
          {{ new Date(user?.created).toLocaleDateString() }}
        </span>
      </div>
    </div>
  </UCard>
</template>
