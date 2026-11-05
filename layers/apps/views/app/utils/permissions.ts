export const VIEWS_PERMISSIONS = [
  'views.use'
] as const

export type ViewsPermission = typeof VIEWS_PERMISSIONS[number]

export const VIEWS_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'views.use': {
    title: 'Use Views',
    description: 'Open the Views app and create boards and tables. What each view shows is still governed by record permissions.'
  }
}

export const VIEWS_DEFAULT_GRANTS: Record<'member' | 'admin', ViewsPermission[]> = {
  member: ['views.use'],
  admin: [...VIEWS_PERMISSIONS]
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<ViewsPermission, true> {}
}
