import { sweepAttachmentTrash } from '../utils/attachments'

// Deletes the stored objects of removed attachments (queued in
// records_attachment_trash by a trigger), shortly after boot and then on a
// cadence. A key whose delete fails stays queued for the next sweep.
const INTERVAL = 10 * 60 * 1000

async function sweep() {
  try {
    while (await sweepAttachmentTrash() > 0) { /* drain the queue a batch at a time */ }
  } catch (err) {
    console.error('records attachment sweep failed:', err)
  }
}

export default defineNitroPlugin(() => {
  setTimeout(sweep, 60_000)
  setInterval(sweep, INTERVAL)
})
