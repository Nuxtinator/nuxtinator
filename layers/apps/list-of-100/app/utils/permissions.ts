// Compile-time + runtime permissions for the List of 100 app.
//
// Three permissions:
//   - list-of-100.access: launcher tile visibility gate.
//   - list-of-100.read:   view your own list (own-only enforced in handlers).
//   - list-of-100.write:  create/edit/delete contacts on your own list.
//
// List of 100 is a personal app: a user holds all three while the app is on
// for them (see `registerApp({ scope: 'user', permissions })`), never through
// roles. Owner-only visibility is enforced inside each route handler by
// filtering `where user_id = ctx.userId`, and by RLS.

export const LIST_OF_100_PERMISSIONS = [
  'list-of-100.access',
  'list-of-100.read',
  'list-of-100.write'
] as const

export type ListOf100Permission = typeof LIST_OF_100_PERMISSIONS[number]

export const LIST_OF_100_PERMISSION_META: Record<string, { title: string, description: string }> = {
  'list-of-100.access': {
    title: 'Access List of 100',
    description: 'Required to open the List of 100 app.'
  },
  'list-of-100.read': {
    title: 'Read your List of 100',
    description: 'View your own contacts and progress.'
  },
  'list-of-100.write': {
    title: 'Edit your List of 100',
    description: 'Add, edit, delete contacts and mark contacted / prayed.'
  }
}

declare module '#permissions' {
  interface PermissionRegistry extends Record<ListOf100Permission, true> {}
}
