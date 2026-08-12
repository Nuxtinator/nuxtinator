export const WORKFLOWS_PERMISSIONS = [
  'workflows.use'
] as const

export type WorkflowsPermission = typeof WORKFLOWS_PERMISSIONS[number]

export const WORKFLOWS_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'workflows.use': {
    title: 'Use Workflows',
    description: 'Open the Workflows app and create views. What each view shows is still governed by CRM record permissions.'
  }
}

export const WORKFLOWS_DEFAULT_GRANTS: Record<'member' | 'admin', WorkflowsPermission[]> = {
  member: ['workflows.use'],
  admin: [...WORKFLOWS_PERMISSIONS]
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<WorkflowsPermission, true> {}
}
