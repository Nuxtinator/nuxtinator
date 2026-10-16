// Permissions added when the tenancy layer is loaded. Single-tenant deploys
// don't see these. The `admin` role is special-cased in core's `rbac.ts` to
// grant every registered permission, so we don't need to list it explicitly
// in default grants — only what `member` (and other future roles) get.

export const ORG_PERMISSIONS = [
  'org.settings.access',
  'org.members.read',
  'org.members.invite',
  'org.members.remove',
  'org.members.manage_roles',
  'org.members.edit_avatar',
  'org.roles.read',
  'org.roles.write',
  'org.roles.delete',
  'org.settings.write',
  'org.apps.manage'
] as const

export type OrgPermission = typeof ORG_PERMISSIONS[number]

export const ORG_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'org.settings.access': {
    title: 'Access org settings',
    description: 'Required to reach /@<slug>/settings and see the org settings shell.'
  },
  'org.members.read': {
    title: 'View members',
    description: 'See the org member list.'
  },
  'org.members.invite': {
    title: 'Invite members',
    description: 'Invite new users into this org.'
  },
  'org.members.remove': {
    title: 'Remove members',
    description: 'Remove members from this org.'
  },
  'org.members.manage_roles': {
    title: 'Manage member roles',
    description: 'Change the roles assigned to a member.'
  },
  'org.members.edit_avatar': {
    title: 'Edit member avatars',
    description: 'Set or remove a member\'s avatar. The avatar belongs to their account, so it shows in every org they are in.'
  },
  'org.roles.read': {
    title: 'View roles',
    description: 'View static and custom roles for this org.'
  },
  'org.roles.write': {
    title: 'Edit roles',
    description: 'Create and modify custom roles, and override static-role permissions.'
  },
  'org.roles.delete': {
    title: 'Delete roles',
    description: 'Delete custom roles in this org.'
  },
  'org.settings.write': {
    title: 'Edit org settings',
    description: 'Edit org name and slug; view the org activity log.'
  },
  'org.apps.manage': {
    title: 'Manage apps',
    description: 'Enable or disable apps for this org.'
  }
}

// Members can see who's in the org. Everything else is admin-only by default.
// Org admins get the full set via the `admin` special-case in rbac.ts.
export const ORG_DEFAULT_GRANTS: Record<'member' | 'admin', OrgPermission[]> = {
  member: ['org.members.read'],
  admin: []
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<OrgPermission, true> {}
}
