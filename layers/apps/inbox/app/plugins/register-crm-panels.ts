// Inject the inbox conversations panel onto CRM contact record pages. CRM's
// record detail page reads `getRecordsDetailPanels(type)` from the `#crm` alias; we
// register at app-plugin time so the registry is populated before the page
// renders. The panel self-gates on inbox.access, so registering it
// unconditionally is safe (a viewer without the permission sees nothing).
import { registerRecordsDetailPanel } from '#records'
import InboxRecordsConversationsPanel from '../components/inbox/CrmConversationsPanel.vue'

export default defineNuxtPlugin(() => {
  registerRecordsDetailPanel({
    id: 'inbox-conversations',
    recordTypes: ['contacts'],
    component: InboxRecordsConversationsPanel,
    order: 50
  })
})
