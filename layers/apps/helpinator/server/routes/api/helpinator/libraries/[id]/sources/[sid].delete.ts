// DELETE /api/helpinator/libraries/:id/sources/:sid — remove a URL entry and
// every page (and chunk) it owns.
import { withOrgPermission } from '#tenant/server'
import { helpinatorGetLibraryOr404, helpinatorGetSourceOr404, helpinatorDeleteSource } from '../../../../../../utils/helpinator-libraries'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx) => {
    const library = await helpinatorGetLibraryOr404(tx, getRouterParam(event, 'id') ?? '')
    const source = await helpinatorGetSourceOr404(tx, library.id, getRouterParam(event, 'sid') ?? '')
    await helpinatorDeleteSource(tx, source)
    return { ok: true }
  })
})
