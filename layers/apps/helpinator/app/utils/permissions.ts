export const HELPINATOR_PERMISSIONS = [
  'helpinator.access',
  'helpinator.manage'
] as const

export type HelpinatorPermission = typeof HELPINATOR_PERMISSIONS[number]

export const HELPINATOR_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'helpinator.access': {
    title: 'Access Helpinator',
    description: 'Open the Helpinator app and read the help-chat conversation log.'
  },
  'helpinator.manage': {
    title: 'Manage help widgets',
    description: 'Create and configure help-chat widgets.'
  }
}

// Admin gets everything (rbac special-cases the admin role); members get
// nothing by default — grant via a role or per-user grants.
export const HELPINATOR_DEFAULT_GRANTS = {
  admin: [...HELPINATOR_PERMISSIONS],
  member: []
}

declare module '#permissions' {
  interface PermissionRegistry {
    'helpinator.access': true
    'helpinator.manage': true
  }
}
