// DELETE /api/helpinator/libraries/:id — refused (409) while a widget lists it.
import { withOrgPermission } from '#tenant/server'
import { helpinatorDeleteLibrary } from '../../../../utils/helpinator-libraries'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    await helpinatorDeleteLibrary(tx, getRouterParam(event, 'id') ?? '')
    return { ok: true }
  })
})
