<script setup lang="ts">
const form = defineModel<{ name: string, color: string, visibility: string, teamIds: string[], fresh?: boolean }>('modelValue', { required: true })
defineProps<{ submitting?: boolean, error?: string | null, submitLabel?: string }>()
defineEmits(['submit'])
</script>

<template>
  <form class="space-y-4" @submit.prevent="$emit('submit')">
    <UFormField label="Name" required>
      <UInput v-model="form.name" autofocus />
    </UFormField>
    <UFormField label="Color">
      <UInput v-model="form.color" type="color" />
    </UFormField>
    <TeamAccessField
      v-model:visibility="form.visibility"
      v-model:team-ids="form.teamIds"
      v-model:fresh="form.fresh"
      app-id="context"
    />
    <p v-if="error" class="text-(--ui-error) text-sm">
      {{ error }}
    </p>
    <UButton type="submit" color="primary" :loading="submitting">
      {{ submitLabel ?? 'Save' }}
    </UButton>
  </form>
</template>
