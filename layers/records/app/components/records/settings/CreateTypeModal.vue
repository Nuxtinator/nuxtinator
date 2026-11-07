<script setup lang="ts">
// Create-a-record-type modal: creates the type, applies the chosen access
// preset to its role grants, then opens the new type's settings page.
import type { RecordsTypeAccess } from '../../../composables/useRecordsPermissionsAdmin'

const open = defineModel<boolean>('open', { default: false })

const admin = useRecordsSchemaAdmin()
const { applyTypeAccess } = useRecordsPermissionsAdmin()
const toast = useToast()
const settingsPath = useRecordsSettingsPath()

const creating = ref(false)
const createError = ref<string | null>(null)

watch(open, (v) => {
  if (v) createError.value = null
})

async function onCreate(payload: { typeKey: string, label: string, labelSingular: string, icon: string | null, access?: RecordsTypeAccess }) {
  creating.value = true
  createError.value = null
  try {
    const created = await admin.createType({
      typeKey: payload.typeKey,
      label: payload.label,
      labelSingular: payload.labelSingular,
      icon: payload.icon ?? undefined
    })
    try {
      await applyTypeAccess(created.key, payload.access ?? 'involved')
    } catch (err) {
      toast.add({
        color: 'error',
        title: 'Type created, but its access wasn\'t saved',
        description: recordsErrorMessage(err, 'Set it in the type\'s permissions.')
      })
    }
    open.value = false
    await navigateTo(settingsPath(`/types/${created.key}`))
  } catch (err) {
    createError.value = recordsErrorMessage(err, 'Failed to create record type')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <div class="p-6 space-y-4">
        <h2 class="text-lg font-semibold">
          New record type
        </h2>
        <UAlert
          v-if="createError"
          color="error"
          :title="createError"
        />
        <RecordsSettingsTypeForm
          mode="create"
          :busy="creating"
          @submit="onCreate"
          @cancel="open = false"
        />
      </div>
    </template>
  </UModal>
</template>
