// The contacts type's own slug namespace (its manifest names `crm.contacts`
// as its permissionPrefix) plus the app gate. Channel types, consent and
// address changes ride the records kernel's schema and connected-app slugs
// (records.schema.manage, records.read, records.write).
export const CRM_PERMISSIONS = [
  'crm.access',
  'crm.contacts.read',
  'crm.contacts.create',
  'crm.contacts.update',
  'crm.contacts.delete',
  'crm.contacts.share',
  'crm.contacts.view_all'
] as const

export type CrmPermission = typeof CRM_PERMISSIONS[number]

export const CRM_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'crm.access': {
    title: 'Access CRM',
    description: 'Required to open the CRM app.'
  },
  'crm.contacts.read': {
    title: 'View contacts',
    description: 'View contact records assigned or shared to you.'
  },
  'crm.contacts.create': {
    title: 'Create contacts',
    description: 'Create new contact records.'
  },
  'crm.contacts.update': {
    title: 'Edit contacts',
    description: 'Edit contact fields, channels, and consent.'
  },
  'crm.contacts.delete': {
    title: 'Delete contacts',
    description: 'Permanently delete contact records.'
  },
  'crm.contacts.share': {
    title: 'Share contacts',
    description: 'Share contact records with other users.'
  },
  'crm.contacts.view_all': {
    title: 'View all contacts',
    description: 'See every contact record, not just assigned or shared ones.'
  }
}

export const CRM_DEFAULT_GRANTS: Record<'member' | 'admin', CrmPermission[]> = {
  member: [
    'crm.access',
    'crm.contacts.read',
    'crm.contacts.create',
    'crm.contacts.update',
    'crm.contacts.share'
  ],
  admin: [...CRM_PERMISSIONS]
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<CrmPermission, true> {}
}
