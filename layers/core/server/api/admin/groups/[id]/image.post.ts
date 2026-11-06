import { getRouterParam } from 'h3'
import { db } from '#core/server/utils/database'
import { requireOperatorAdmin } from '#tenant/server'
import { logUpdate } from '../../../../utils/activity-logger'
import { requireHostGroup } from '../../../../utils/admin-groups'
import { applyUploadedImage } from '../../../../utils/avatar'
import { setGroupImage } from '../../../../utils/groups'

// Host admin uploads a host group's image (multipart field `file`).
export default defineEventHandler(async (event) => {
  const { userId } = await requireOperatorAdmin(event)
  const group = await requireHostGroup(db, getRouterParam(event, 'id'))
  const image = await applyUploadedImage(event, async (url) => {
    await setGroupImage(db, group.id, url)
    return url
  })
  logUpdate('groups', group.id, userId, { image })
  return { image }
})
