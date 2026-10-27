<script setup lang="ts">
// Confirmation dialog for destructive or irreversible actions. Either the
// parent owns the async work (v-model:open + @confirm, keeping `loading` on
// while the request runs and closing the modal when done), or useConfirm()
// opens it as a plain yes/no.
const open = defineModel<boolean>('open', { default: false })

withDefaults(defineProps<{
  title: string
  description?: string
  confirmLabel?: string
  color?: 'error' | 'primary'
  loading?: boolean
}>(), { description: undefined, confirmLabel: 'Confirm', color: 'error', loading: false })

const emit = defineEmits<{ confirm: [], close: [value: boolean] }>()

function onConfirm() {
  emit('confirm')
  emit('close', true)
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :dismissible="!loading" :ui="{ content: 'max-w-md' }">
    <template #body>
      <slot>
        <p v-if="description" class="text-sm text-(--ui-text-muted)">
          {{ description }}
        </p>
      </slot>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" :disabled="loading" @click="open = false">
          Cancel
        </UButton>
        <UButton :color="color" :loading="loading" @click="onConfirm">
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
