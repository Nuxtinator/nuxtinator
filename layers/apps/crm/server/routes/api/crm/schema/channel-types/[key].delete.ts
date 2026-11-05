// DELETE /api/crm/schema/channel-types/:key
// Deletes an admin-created channel type. Code-registered channel types 400
// (their existence is a code fact); types with claimed crm_channels rows 409
// (those rows carry consent/suppression history). Permission:
// records.schema.manage.

import { withOrgPermission } from '#tenant/server'
import { removeChannelType } from '#crm/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'key')!
  return await withOrgPermission(event, { appId: 'crm' }, 'records.schema.manage', async (tx, ctx) => {
    await removeChannelType(tx, ctx, typeKey)
    return { ok: true }
  })
})
