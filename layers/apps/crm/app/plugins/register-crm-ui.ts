// Plugs the crm's contacts UI into the records UI: contacts live under
// /crm/contacts, channel fields render through the channel widget, the
// schema builder picks a channel type for new channel fields, and the
// records settings page lists channel types.
import { registerRecordsFieldKindSettings, registerRecordsFieldWidget, registerRecordsSettingsSection, registerRecordsTypeRoute } from '#records'
import ChannelFieldWidget from '../components/crm/ChannelFieldWidget.vue'
import ChannelTypePicker from '../components/crm/ChannelTypePicker.vue'
import ChannelTypesSection from '../components/crm/ChannelTypesSection.vue'

export default defineNuxtPlugin(() => {
  registerRecordsTypeRoute({ id: 'crm:contacts', recordType: 'contacts', base: '/crm/contacts' })
  registerRecordsFieldWidget({ id: 'crm:channels', kind: 'communication_channel', component: ChannelFieldWidget })
  registerRecordsFieldKindSettings({
    id: 'crm:channel-type',
    kind: 'communication_channel',
    component: ChannelTypePicker,
    isComplete: value => typeof value.channelType === 'string' && value.channelType !== ''
  })
  registerRecordsSettingsSection({ id: 'crm:channel-types', title: 'Channel types', component: ChannelTypesSection, order: 50 })
})
