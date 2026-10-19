export const INBOX_PERMISSIONS = [
  // Open the app, read conversations, and triage them (status, assignment,
  // review flags, counts, attachment download).
  'inbox.access',
  // Compose and reply, plus the mutations that shape what gets sent or
  // received on the org's behalf: spam blocklist, canned responses.
  'inbox.send',
  // The settings page: inbox configuration and teammates' sending aliases.
  'inbox.settings.manage'
] as const

export type InboxPermission = typeof INBOX_PERMISSIONS[number]

export const INBOX_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'inbox.access': {
    title: 'Access inbox',
    description: 'Open the shared inbox, read conversations, and triage them (status, assignment, review flags).'
  },
  'inbox.send': {
    title: 'Send email',
    description: 'Compose new conversations and reply to contacts; manage the spam blocklist and canned responses.'
  },
  'inbox.settings.manage': {
    title: 'Manage inbox settings',
    description: 'Configure the inbox (sender name, auto-replies, contact-form key, notifications) and set teammates\' sending aliases.'
  }
}

// The inbox is a staff tool: nothing by default for members — grant via role
// or per-user grants. Admin gets everything (the `admin` role also unions all
// registered permissions in core's RBAC anyway).
export const INBOX_DEFAULT_GRANTS: Record<'member' | 'admin', InboxPermission[]> = {
  member: [],
  admin: [...INBOX_PERMISSIONS]
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<InboxPermission, true> {}
}
