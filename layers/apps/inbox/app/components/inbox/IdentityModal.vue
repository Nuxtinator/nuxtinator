<script setup lang="ts">
// Self-service editor for the caller's sending identity: everyone edits their
// signature; only admins see the alias field (mirrors the server's split
// permission). The signature preview renders the agent's own HTML — self-XSS
// only — but is sanitized here anyway before display.
import type { InboxMe } from '../../composables/useInboxMe'

const props = defineProps<{ me: InboxMe | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [patch: { alias?: string | null, signature?: string | null }] }>()

const alias = ref('')
const signature = ref('')

watch(open, (v) => {
  if (v) {
    alias.value = props.me?.alias ?? ''
    signature.value = props.me?.signature ?? ''
  }
})

function save() {
  const patch: { alias?: string | null, signature?: string | null } = { signature: signature.value || null }
  // Only send `alias` when the user may manage it — otherwise the server 403s.
  if (props.me?.canManageSettings) patch.alias = alias.value.trim() || null
  emit('save', patch)
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" title="My sending identity" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="space-y-3">
        <UFormField
          v-if="me?.canManageSettings"
          label="Alias"
          description="Mail to <alias>@ your inbound domain routes to you, and personal replies send From that address."
        >
          <UInput v-model="alias" placeholder="e.g. jane" class="w-full" />
        </UFormField>
        <UFormField label="Signature" description="Appended to replies you send from your personal address.">
          <UEditor
            v-model="signature"
            content-type="html"
            placeholder="Your signature…"
            :image="false"
            :mention="false"
            class="min-h-24 max-h-48 overflow-y-auto rounded-md border border-(--ui-border)"
          />
        </UFormField>
        <div v-if="signature" class="text-xs text-(--ui-text-muted)">
          <p class="mb-1">Preview</p>
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized, and it is the agent's own signature (self-XSS only) -->
          <div class="border border-(--ui-border) rounded-md p-2" v-html="inboxSanitizeDisplayHtml(signature)" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton label="Cancel" variant="ghost" color="neutral" @click="open = false" />
        <UButton label="Save" icon="i-lucide-save" @click="save" />
      </div>
    </template>
  </UModal>
</template>
