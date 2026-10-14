<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})
</script>

<template>
  <div class="max-w-2xl mx-auto space-y-6">
    <h1 class="text-3xl font-bold">
      Account Settings
    </h1>

    <AccountInfo />
    <AccountAvatar />
    <AccountAppearance />
    <AccountDisplayName />
    <AccountEmail />
    <AccountPassword />
    <AccountSignInMethods />
    <AccountSessions />
    <AccountSections />
    <AccountSignOut />
    <AccountDelete />

    <ReauthModal />
  </div>
</template>
