// GET /api/crm/schema/channel-types
// Merged channel-type catalog (code-registered ⊳ crm_channel_types rows),
// each flagged custom for admin-created ones. Custom types have no icon
// column, so their icon rides in config.icon. Also returns `canManage` —
// whether the caller holds records.schema.manage — which the settings UI uses
// as its access signal. Permission: crm.access.

import { withOrgPermission } from '#tenant/server'
import { getChannelTypes } from '#crm/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.access', async (tx, ctx) => {
    const types = await getChannelTypes(tx)
    return {
      canManage: ctx.perms.has('records.schema.manage'),
      channelTypes: types.map(t => ({
        key: t.typeKey,
        label: t.label,
        icon: t.icon ?? (typeof t.config.icon === 'string' ? t.config.icon : null),
        valueFormat: t.valueFormat,
        custom: t.custom
      }))
    }
  })
})
