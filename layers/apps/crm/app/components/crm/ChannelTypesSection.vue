<script setup lang="ts">
// The records settings page's channel-types section (registered in
// plugins/register-crm-ui.ts).
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-(--ui-text-muted)">
      Ways of reaching a contact — email, phone, and any custom channels you add.
    </p>
    <CrmSettingsChannelTypeList />
  </div>
</template>
