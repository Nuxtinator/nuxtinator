// Nitro plugin added to the core test build by global-setup.ts: a personal app
// whose notes can be shared, to exercise core's sharing.
import { defineNitroPlugin } from 'nitropack/runtime'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerShareTable } from '#core/server/utils/share-registry'

export default defineNitroPlugin(() => {
  registerPermissions(['test-core-notes.read'])
  registerApp({
    id: 'test-core-notes',
    title: 'Test Notes',
    path: '/test-core-notes',
    scope: 'user',
    permissions: ['test-core-notes.read'],
    defaultStatus: 'default'
  })
  registerShareTable({ appId: 'test-core-notes', table: 'test_core_note_shares' })
})
