// The records layer's own schema-builder extension: connection fields pick
// the record type they link to.
import { registerRecordsFieldKindSettings } from '#records'
import ConnectionTargetPicker from '../components/records/settings/ConnectionTargetPicker.vue'

export default defineNuxtPlugin(() => {
  registerRecordsFieldKindSettings({
    id: 'records:connection-target',
    kind: 'connection',
    component: ConnectionTargetPicker,
    isComplete: value => typeof value.target === 'string' && value.target !== ''
  })
})
