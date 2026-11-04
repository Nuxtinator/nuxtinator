// Org offboarding: when the host deletes an org, its videos rows cascade
// away — but the S3 objects they reference (video files + thumbnails) would
// orphan forever. The `org.deleted` hook fires before the row cascade, so
// the org's rows are still readable through RLS. Cleanup is best-effort per
// the hook contract: a failure logs and never blocks the org delete.
import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { deleteVideoObject } from '../utils/video-storage'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('org.deleted', async ({ orgId }) => {
    const rows = await db.transaction().execute(async (tx) => {
      await sql`select set_config('app.current_org', ${orgId}, true)`.execute(tx)
      return await tx.selectFrom('videos')
        .select(['s3_key', 'thumbnail_url'])
        .where('org_id', '=', orgId)
        .execute()
    })
    if (rows.length === 0) return
    let deleted = 0
    let failed = 0
    for (const row of rows) {
      for (const key of [row.s3_key, row.thumbnail_url]) {
        if (!key) continue
        try {
          const stripped = key.startsWith('videos/') ? key.slice('videos/'.length) : key
          await deleteVideoObject(stripped)
          deleted++
        } catch (err) {
          failed++
          console.error('[videos] org offboarding S3 cleanup failed for', key, err)
        }
      }
    }
    console.log(`[videos] org ${orgId} offboarded — S3 cleanup: ${deleted} deleted, ${failed} failed`)
  })
})
