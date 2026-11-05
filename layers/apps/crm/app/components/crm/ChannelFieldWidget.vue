<script setup lang="ts">
// The records detail page's field widget for communication_channel fields
// (registered in plugins/register-crm-ui.ts): adapts the page's widget props
// to the channel widget, and locks the addresses a linked user account owns.
import type { CrmChannelEntry } from '#crm'
import { ACCOUNT_OWNED_CHANNEL_TYPES } from '#crm'
import type { RecordsFieldSetting } from '#records/client'

const props = defineProps<{
  record: { id: string, userId: string | null }
  typeKey: string
  field: RecordsFieldSetting
  value: unknown
  editable: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const entries = computed(() => Array.isArray(props.value) ? props.value as CrmChannelEntry[] : [])
const addressesLocked = computed(() =>
  !!props.record.userId && !!props.field.channelType && ACCOUNT_OWNED_CHANNEL_TYPES.includes(props.field.channelType))
</script>

<template>
  <CrmChannelWidget
    :record-id="record.id"
    :type-key="typeKey"
    :field="field"
    :entries="entries"
    :editable="editable"
    :addresses-locked="addressesLocked"
    @refresh="emit('refresh')"
  />
</template>
