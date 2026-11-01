<script setup lang="ts">
// Asks for the reason when a record is closed. Emits the chosen reason key;
// the page sends it with the status change. A reason that revokes consent
// says so before it is confirmed.
import type { CrmFieldSetting } from '../../utils/field-kinds'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  recordName: string
  /** The type's closed-reason field. */
  reasonField: CrmFieldSetting
  saving: boolean
}>()

const emit = defineEmits<{
  confirm: [reason: string]
}>()

const reason = ref<string | undefined>()
watch(open, (v) => {
  if (v) reason.value = undefined
})

const items = computed(() =>
  Object.entries(props.reasonField.options ?? {})
    .filter(([, o]) => !o.deleted)
    .map(([value, o]) => ({ label: o.label, value }))
)

const revokes = computed(() => !!(reason.value && props.reasonField.options?.[reason.value]?.revokesConsent))

function confirm() {
  if (reason.value) emit('confirm', reason.value)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :dismissible="!saving"
  >
    <template #content>
      <form
        class="p-6 space-y-4"
        @submit.prevent="confirm"
      >
        <h2 class="text-lg font-semibold">
          Close {{ recordName || 'this record' }}
        </h2>
        <UFormField
          :label="reasonField.label"
          required
        >
          <USelect
            v-model="reason"
            :items="items"
            placeholder="Choose a reason"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UAlert
          v-if="revokes"
          color="warning"
          icon="i-lucide-shield-off"
          title="This also turns off every consent on this record's email addresses and phone numbers, including for other records that share them."
        />
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :loading="saving"
            :disabled="!reason"
          >
            Close record
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
