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

    <AccountGroup title="Profile">
      <AccountAvatar />
      <AccountDisplayName />
      <AccountMemberSince />
    </AccountGroup>

    <AccountGroup title="Sign-in & security">
      <AccountEmail />
      <AccountPassword />
      <AccountSignInMethods />
      <AccountSessions />
    </AccountGroup>

    <AccountGroup title="Preferences">
      <AccountAppearance />
    </AccountGroup>

    <AccountSections />

    <AccountGroup title="Danger zone">
      <AccountSignOut />
      <AccountDelete />
    </AccountGroup>

    <ReauthModal />
  </div>
</template>
