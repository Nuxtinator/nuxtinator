// GET /api/inbox/identities → every org member with their alias/signature
// state, for the identities manager on the settings page. Gated on
// inbox.settings.manage (aliases are routable, so managing them takes more
// than inbox.send).
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.settings.manage', async (tx) => {
    const rows = await tx
      .selectFrom('inbox_identities')
      .select(['user_id', 'alias', 'signature'])
      .execute()
    return {
      identities: rows.map(r => ({
        userId: r.user_id,
        alias: r.alias,
        hasSignature: !!r.signature
      }))
    }
  })
})
