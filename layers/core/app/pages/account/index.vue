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

    <SettingsGroup title="Profile">
      <AccountAvatar />
      <AccountDisplayName />
      <AccountMemberSince />
    </SettingsGroup>

    <SettingsGroup title="Sign-in & security">
      <AccountEmail />
      <AccountPassword />
      <AccountSignInMethods />
      <AccountSessions />
    </SettingsGroup>

    <SettingsGroup title="Preferences">
      <AccountAppearance />
    </SettingsGroup>

    <AccountSections />

    <SettingsGroup title="Danger zone">
      <AccountSignOut />
      <AccountDelete />
    </SettingsGroup>

    <ReauthModal />
  </div>
</template>
