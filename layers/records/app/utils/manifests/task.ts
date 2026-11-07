import { defineRecordType } from '#records'
import type { InferRecordShape } from '#records'

// The built-in task type: something to do, optionally owned by one person
// and due on a date. Done is the closed status, so a done task leaves default
// lists the way any closed record does. Producer layers (meetings) write
// their action items as tasks.
export const taskManifest = defineRecordType({
  key: 'task',
  label: 'Tasks',
  labelSingular: 'Task',
  icon: 'i-lucide-square-check',
  statusField: 'status',
  sections: {
    details: { label: 'Details', order: 1 }
  },
  fields: {
    name: { kind: 'text', label: 'Name', column: 'name', required: true, section: 'details', order: 1 },
    status: {
      kind: 'key_select',
      label: 'Status',
      column: 'status',
      section: 'details',
      order: 2,
      default: 'open',
      options: {
        open: { label: 'Open', color: 'info' },
        done: { label: 'Done', color: 'success', closed: true }
      }
    },
    assignee: { kind: 'user_select', label: 'Assignee', section: 'details', order: 3 },
    due_date: { kind: 'date', label: 'Due date', icon: 'i-lucide-calendar', section: 'details', order: 4 },
    description: { kind: 'textarea', label: 'Description', section: 'details', order: 5 }
  },
  card: { fields: ['status', 'assignee', 'due_date'] }
})

declare module '#records' {
  interface RecordTypeRegistry {
    task: InferRecordShape<typeof taskManifest>
  }
}
