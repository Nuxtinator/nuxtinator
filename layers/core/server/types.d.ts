// Host-emitted Nitro hooks layers can subscribe to.
//
// Layer authors register handlers in their own Nitro plugin via:
//
//   const nitro = useNitroApp()
//   nitro.hooks.hook('membership.created', async (p) => { ... })
//
// Hook handlers MUST be best-effort — a thrown handler does NOT roll back the
// triggering DB write. The host wraps each handler in try/catch and logs the
// error. See [documentation/layers.md](../documentation/layers.md) for the
// full reference.

interface CoreHookMap {
  'org.created': (p: {
    orgId: string
    slug: string
    createdByUserId: string | null
  }) => void | Promise<void>
  'org.deleted': (p: {
    orgId: string
    slug: string
  }) => void | Promise<void>
  'user.created': (p: {
    userId: string
    email: string
    viaInvite: boolean
  }) => void | Promise<void>
  // Fired (and awaited) just before a user row is deleted, while everything
  // tied to it still exists.
  'user.deleting': (p: {
    userId: string
  }) => void | Promise<void>
  // Fired after the user row's deletion has committed, with the avatar it had.
  'user.deleted': (p: {
    userId: string
    avatar: string
  }) => void | Promise<void>
  'user.verified': (p: {
    userId: string
    email: string
  }) => void | Promise<void>
  // The user's display name or email changed (after the write committed).
  'user.updated': (p: {
    userId: string
    fields: ('display_name' | 'email')[]
  }) => void | Promise<void>
  'membership.created': (p: {
    membershipId: string
    userId: string
    orgId: string
    roles: string[]
    createdByUserId: string | null
  }) => void | Promise<void>
  'membership.updated': (p: {
    membershipId: string
    userId: string
    orgId: string
    oldRoles: string[]
    newRoles: string[]
  }) => void | Promise<void>
  'membership.deleted': (p: {
    membershipId: string
    userId: string
    orgId: string
  }) => void | Promise<void>
  'app.enabled': (p: {
    orgId: string
    appId: string
  }) => void | Promise<void>
  'app.disabled': (p: {
    orgId: string
    appId: string
  }) => void | Promise<void>
  // An invite was accepted, after its orgs and personal apps were granted.
  // `appIds` are the personal apps it carried. `inviteId` is null when the
  // invited address already had an account, which was attached directly.
  'invite.accepted': (p: {
    inviteId: string | null
    userId: string
    invitedByUserId: string | null
    appIds: string[]
  }) => void | Promise<void>
}

// Nitro publishes the hook map under several entry points across versions
// (`nitropack`, `nitropack/types`, `nitropack/runtime`). Augment all three so
// `nitroApp.hooks.callHook(...)` is typed against the host hooks no matter
// which entry a given Nitro release routes `useNitroApp()` through.
declare module 'nitropack/types' {
  interface NitroRuntimeHooks extends CoreHookMap {}
}

declare module 'nitropack' {
  interface NitroRuntimeHooks extends CoreHookMap {}
}

declare module 'nitropack/runtime' {
  interface NitroRuntimeHooks extends CoreHookMap {}
}

export {}
