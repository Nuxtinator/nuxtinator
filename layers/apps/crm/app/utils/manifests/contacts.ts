import { defineRecordType } from '../crm-manifest'
import type { InferRecordShape } from '../crm-manifest'

// The contacts record type — the code-shipped flagship type. Field set drawn
// from the Disciple.Tools contact base fields, trimmed to the v1 kinds.
export const contactsManifest = defineRecordType({
  key: 'contacts',
  label: 'Contacts',
  labelSingular: 'Contact',
  icon: 'i-lucide-contact',
  statusField: 'status',
  closedReasonField: 'reason_closed',
  sections: {
    details: { label: 'Details', order: 1 },
    channels: { label: 'Contact info', order: 2 },
    background: { label: 'Background', order: 3 }
  },
  fields: {
    name: { kind: 'text', label: 'Name', column: 'name', required: true, section: 'details', order: 1 },
    status: {
      kind: 'key_select',
      label: 'Status',
      column: 'status',
      section: 'details',
      order: 2,
      default: 'new',
      options: {
        new: { label: 'New', color: 'info' },
        active: { label: 'Active', color: 'success' },
        paused: { label: 'Paused', color: 'warning' },
        closed: { label: 'Closed', color: 'neutral', closed: true }
      }
    },
    reason_closed: {
      kind: 'key_select',
      label: 'Reason closed',
      section: 'details',
      order: 3,
      options: {
        duplicate: { label: 'Duplicate' },
        not_interested: { label: 'Not interested' },
        not_responding: { label: 'Not responding' },
        moved: { label: 'Moved away' },
        asked_to_be_removed: { label: 'Asked to be removed', revokesConsent: true },
        other: { label: 'Other' }
      }
    },
    assigned_to: { kind: 'user_select', label: 'Assigned to', multiple: true, section: 'details', order: 4 },
    nickname: { kind: 'text', label: 'Nickname', section: 'details', order: 5 },
    contact_email: { kind: 'communication_channel', label: 'Email', channelType: 'email', section: 'channels', order: 1 },
    contact_phone: { kind: 'communication_channel', label: 'Phone', channelType: 'phone', section: 'channels', order: 2 },
    gender: {
      kind: 'key_select',
      label: 'Gender',
      section: 'background',
      order: 1,
      options: {
        male: { label: 'Male' },
        female: { label: 'Female' }
      }
    },
    languages: {
      kind: 'multi_select',
      label: 'Languages',
      section: 'background',
      order: 3,
      options: {
        en: { label: 'English' },
        es: { label: 'Spanish' },
        fr: { label: 'French' },
        ar: { label: 'Arabic' }
      }
    },
    sources: {
      kind: 'multi_select',
      label: 'Sources',
      section: 'background',
      order: 4,
      options: {
        personal: { label: 'Personal' },
        web: { label: 'Web' },
        transfer: { label: 'Transfer' }
      }
    },
    tags: { kind: 'tags', label: 'Tags', section: 'background', order: 5 },
    relation: { kind: 'connection', label: 'Relations', target: 'contacts', reverseKey: 'relation', section: 'background', order: 6 }
  }
})

declare module '#crm' {
  interface CrmRecordTypeRegistry {
    contacts: InferRecordShape<typeof contactsManifest>
  }
}
