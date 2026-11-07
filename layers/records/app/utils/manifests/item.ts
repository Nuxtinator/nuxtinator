import { defineRecordType } from '#records'
import type { InferRecordShape } from '#records'

// The built-in item type: a freeform card — an idea, a link, a note. Boards
// give items their meaning, so the type itself carries almost nothing.
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
    tags: { kind: 'tags', label: 'Tags', section: 'details', order: 3 }
  },
  card: { fields: ['tags'] }
})

declare module '#records' {
  interface RecordTypeRegistry {
    item: InferRecordShape<typeof itemManifest>
  }
}
