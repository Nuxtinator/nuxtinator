// POST /api/helpinator/libraries — create a library (website or portfolio).
import { withOrgPermission } from '#tenant/server'
import { HelpinatorLibraryInput, helpinatorAssertContextRead, helpinatorCreateLibrary } from '../../../../utils/helpinator-libraries'
import { helpinatorAdminLibrary } from '../../../../utils/helpinator-admin'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    const parsed = HelpinatorLibraryInput.safeParse(await readBody(event))
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid library', data: parsed.error.flatten() })
    if (parsed.data.kind === 'portfolio') helpinatorAssertContextRead(ctx)
    setResponseStatus(event, 201)
    return helpinatorAdminLibrary(await helpinatorCreateLibrary(tx, parsed.data, ctx.userId))
  })
})
