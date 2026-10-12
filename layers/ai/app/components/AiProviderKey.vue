<script setup lang="ts">
import type { AiKeyStatus, AiProvider } from '#ai'

// One provider's API key on the host or org AI page: its state, and the
// add / replace / remove actions. A key set in the environment (`envVar`) is
// shown read-only. The key itself is never displayed, only its last four.

const props = withDefaults(defineProps<{
  provider: AiProvider
  label: string
  status: AiKeyStatus
  last4: string
  envVar?: string
  disabled?: boolean
  // Shown under "No key" (e.g. what adding one unlocks).
  emptyHint?: string
  // Verifies and stores the key; resolves true when it was saved.
  save: (key: string) => Promise<boolean>
}>(), {
  envVar: '',
  disabled: false,
  emptyHint: ''
})

const emit = defineEmits<{ remove: [] }>()

const PLACEHOLDERS: Record<AiProvider, string> = {
  openrouter: 'sk-or-…',
  tinfoil: 'tk_…',
  openai: 'sk-…',
  anthropic: 'sk-ant-…'
}

const editing = ref(false)
const input = ref('')

async function submit() {
  const key = input.value.trim()
  if (key && await props.save(key)) {
    editing.value = false
    input.value = ''
  }
}
</script>

<template>
  <div class="border border-(--ui-border) rounded-md p-4 space-y-3">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0 text-sm">
        <template v-if="envVar">
          <div class="font-medium flex items-center gap-2">
            <UIcon
              name="i-lucide-key-round"
              class="size-4"
            />
            Set in the environment
          </div>
          <div class="text-(--ui-text-muted)">
            From <span class="font-mono">{{ envVar }}</span>. Change it there.
          </div>
        </template>
        <template v-else-if="status === 'ok'">
          <div class="font-medium flex items-center gap-2">
            <UIcon
              name="i-lucide-key-round"
              class="size-4"
            />
            Key ending in <span class="font-mono">{{ last4 }}</span>
          </div>
        </template>
        <template v-else-if="status === 'undecryptable'">
          <div class="font-medium text-(--ui-error)">
            Stored key can't be read
          </div>
          <div class="text-(--ui-text-muted)">
            Remove it and enter it again.
          </div>
        </template>
        <template v-else>
          <div class="font-medium">
            No {{ label }} key
          </div>
          <div
            v-if="emptyHint"
            class="text-(--ui-text-muted)"
          >
            {{ emptyHint }}
          </div>
        </template>
      </div>

      <div
        v-if="!envVar && !editing"
        class="flex items-center gap-2 shrink-0"
      >
        <UButton
          v-if="status === 'none'"
          icon="i-lucide-plus"
          :disabled="disabled"
          @click="editing = true"
        >
          Add key
        </UButton>
        <UButton
          v-else-if="status === 'ok'"
          variant="outline"
          color="neutral"
          :disabled="disabled"
          @click="editing = true"
        >
          Replace
        </UButton>
        <UButton
          v-if="status !== 'none'"
          variant="ghost"
          color="error"
          :disabled="disabled"
          @click="emit('remove')"
        >
          Remove
        </UButton>
      </div>
    </div>

    <form
      v-if="editing"
      class="flex items-start gap-2 flex-wrap"
      @submit.prevent="submit"
    >
      <UInput
        v-model="input"
        type="password"
        :placeholder="PLACEHOLDERS[provider]"
        autocomplete="off"
        class="flex-1 min-w-48 font-mono"
        :disabled="disabled"
      />
      <UButton
        type="submit"
        :loading="disabled"
        :disabled="!input.trim()"
      >
        Verify and save
      </UButton>
      <UButton
        variant="ghost"
        color="neutral"
        :disabled="disabled"
        @click="editing = false; input = ''"
      >
        Cancel
      </UButton>
      <p class="basis-full text-xs text-(--ui-text-muted)">
        Checked with {{ label }}, then stored encrypted and never shown again.
      </p>
    </form>
  </div>
</template>
