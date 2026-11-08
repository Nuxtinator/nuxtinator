import { defineRecordType } from '#records'
import type { InferRecordShape } from '#records'

// The built-in task type: something to do, optionally owned by one person
// and due on a date. Done is the closed status, so a done task leaves default
// lists the way any closed record does. The assignee is the one people field
// that shares the task with whoever it names. Subtasks are tasks linked
// through `parent`, so a card can show their progress. Producer layers
// (meetings) write their action items as tasks.
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
        open: { label: 'To do', color: 'info' },
        in_progress: { label: 'In progress', color: 'warning' },
        done: { label: 'Done', color: 'success', closed: true }
      }
    },
    assignee: { kind: 'user_select', label: 'Assignee', grantsAccess: true, section: 'details', order: 3 },
    priority: {
      kind: 'key_select',
      label: 'Priority',
      icon: 'i-lucide-flag',
      section: 'details',
      order: 4,
      options: {
        low: { label: 'Low', color: 'neutral' },
        medium: { label: 'Medium', color: 'info' },
        high: { label: 'High', color: 'warning' },
        urgent: { label: 'Urgent', color: 'error' }
      }
    },
    start_date: { kind: 'date', label: 'Start date', icon: 'i-lucide-calendar-arrow-up', section: 'details', order: 5 },
    due_date: { kind: 'date', label: 'Due date', icon: 'i-lucide-calendar', section: 'details', order: 6 },
    tags: { kind: 'tags', label: 'Tags', section: 'details', order: 7 },
    parent: { kind: 'connection', label: 'Parent task', target: 'task', reverseKey: 'subtasks', section: 'details', order: 8 },
    subtasks: { kind: 'connection', label: 'Subtasks', target: 'task', reverseKey: 'parent', section: 'details', order: 9 },
    description: { kind: 'textarea', label: 'Description', section: 'details', order: 10 },
    attachments: { kind: 'attachments', label: 'Attachments', icon: 'i-lucide-paperclip', section: 'details', order: 11 }
  },
  card: {
    fields: ['status', 'assignee', 'due_date', 'priority', 'subtasks', 'attachments'],
    connections: { subtasks: 'progress' }
  }
})

declare module '#records' {
  interface RecordTypeRegistry {
    task: InferRecordShape<typeof taskManifest>
  }
}
