import { defineRecordType } from '#records'
import type { InferRecordShape } from '#records'

// The built-in item type: a freeform card — an idea, a link, a note, a
// photo. Boards give items their meaning, so the type carries only what most
// boards want; views add their own fields for the rest. People only records
// who is involved: naming someone doesn't share the item with them.
export const itemManifest = defineRecordType({
  key: 'item',
  label: 'Items',
  labelSingular: 'Item',
  icon: 'i-lucide-sticky-note',
  sections: {
    details: { label: 'Details', order: 1 }
  },
  fields: {
    name: { kind: 'text', label: 'Name', column: 'name', required: true, section: 'details', order: 1 },
    notes: { kind: 'textarea', label: 'Notes', section: 'details', order: 2 },
    tags: { kind: 'tags', label: 'Tags', section: 'details', order: 3 },
    link: { kind: 'link', label: 'Link', icon: 'i-lucide-link', section: 'details', order: 4 },
    date: { kind: 'date', label: 'Date', icon: 'i-lucide-calendar', section: 'details', order: 5 },
    people: { kind: 'user_select', label: 'People', multiple: true, section: 'details', order: 6 },
    priority: {
      kind: 'key_select',
      label: 'Priority',
      icon: 'i-lucide-flag',
      section: 'details',
      order: 7,
      options: {
        low: { label: 'Low', color: 'neutral' },
        medium: { label: 'Medium', color: 'info' },
        high: { label: 'High', color: 'warning' }
      }
    },
    attachments: { kind: 'attachments', label: 'Attachments', icon: 'i-lucide-paperclip', section: 'details', order: 8 }
  },
  card: { fields: ['tags', 'link'], cover: 'attachments' }
})

declare module '#records' {
  interface RecordTypeRegistry {
    item: InferRecordShape<typeof itemManifest>
  }
}
