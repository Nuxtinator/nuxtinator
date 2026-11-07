export const RECORDS_PERMISSIONS = [
  'records.access',
  // Generic slugs covering every record type without a slug namespace of its
  // own (admin-created types, items, tasks). Runtime types cannot mint
  // permission slugs (the registry is code-owned), so they all share this set.
  'records.entries.read',
  'records.entries.create',
  'records.entries.update',
  'records.entries.delete',
  'records.entries.share',
  'records.entries.view_all',
  // Org-level schema builder (record types and fields).
  'records.schema.manage',
  // What a connected app (MCP / OAuth client) may do, across every record
  // type. Which records it can touch is still the per-type answer above.
  'records.read',
  'records.write'
] as const

export type RecordsPermission = typeof RECORDS_PERMISSIONS[number]

export const RECORDS_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'records.access': {
    title: 'Access Records',
    description: 'Required to open the Records app.'
  },
  'records.entries.read': {
    title: 'View records',
    description: 'View records you created, are assigned to, or that are shared with you.'
  },
  'records.entries.create': {
    title: 'Create records',
    description: 'Create new records.'
  },
  'records.entries.update': {
    title: 'Edit records',
    description: 'Edit record fields.'
  },
  'records.entries.delete': {
    title: 'Delete records',
    description: 'Permanently delete records.'
  },
  'records.entries.share': {
    title: 'Share records',
    description: 'Share records with other users.'
  },
  'records.entries.view_all': {
    title: 'View all records',
    description: 'See every record, not just your own, assigned or shared ones.'
  },
  'records.schema.manage': {
    title: 'Manage record types',
    description: 'Create and customize record types and their fields.'
  },
  'records.read': {
    title: 'Read records in connected apps',
    description: 'Let AI assistants and other connected apps read the records you can see.'
  },
  'records.write': {
    title: 'Change records in connected apps',
    description: 'Let AI assistants and other connected apps create, edit and close the records you can edit, and change record types you may manage.'
  }
}

export const RECORDS_DEFAULT_GRANTS: Record<'member' | 'admin', RecordsPermission[]> = {
  member: [
    'records.access',
    'records.entries.read',
    'records.entries.create',
    'records.entries.update',
    'records.entries.share',
    'records.read',
    'records.write'
  ],
  admin: [...RECORDS_PERMISSIONS]
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<RecordsPermission, true> {}
}
