export const INBOX_PERMISSIONS = [
  // Open the app, read conversations, and triage them (status, assignment,
  // review flags, counts, attachment download).
  'inbox.access',
  // Read-only inbox access for AI clients over MCP: list and read
  // conversations, look up assignees and the drafting background. Triage
  // stays on inbox.access, so a token can be granted reading without writing.
  'inbox.read',
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
  'inbox.read': {
    title: 'Read inbox (AI clients)',
    description: 'Let AI clients connected over MCP list and read conversations, without triage or sending.'
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
