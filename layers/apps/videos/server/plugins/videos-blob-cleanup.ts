// Storage cleanup after an account is deleted. The `users` delete trigger
// (videos_003) keeps the uploader's team and org videos and queues the
// storage keys of the private ones the cascade removes in
// `videos_blob_deletes`. Once the delete has committed, this removes those
// objects; a key whose removal fails stays queued for the next deletion.
import { db } from '#core/server/utils/database'
import { deleteVideoObject } from '../utils/video-storage'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('user.deleted', async () => {
    const queued = await db.selectFrom('videos_blob_deletes').select(['id', 's3_key']).execute()
    const done: string[] = []
    for (const row of queued) {
      try {
        const stripped = row.s3_key.startsWith('videos/') ? row.s3_key.slice('videos/'.length) : row.s3_key
        await deleteVideoObject(stripped)
        done.push(row.id)
      } catch (err) {
        console.error('[videos] storage cleanup failed for', row.s3_key, err)
      }
    }
    if (done.length > 0) await db.deleteFrom('videos_blob_deletes').where('id', 'in', done).execute()
  })
})
