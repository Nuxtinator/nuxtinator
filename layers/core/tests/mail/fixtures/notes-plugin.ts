// Nitro plugin added to the core-mail test build: a personal app whose notes
// can be shared, to exercise share invites to suppressed addresses.
import { defineNitroPlugin } from 'nitropack/runtime'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerShareTable } from '#core/server/utils/share-registry'

export default defineNitroPlugin(() => {
  registerPermissions(['test-core-mail-notes.read'])
  registerApp({
    id: 'test-core-mail-notes',
    title: 'Test Mail Notes',
    path: '/test-core-mail-notes',
    scope: 'user',
    permissions: ['test-core-mail-notes.read'],
    defaultStatus: 'default'
  })
  registerShareTable({ appId: 'test-core-mail-notes', table: 'test_core_mail_note_shares' })
})
