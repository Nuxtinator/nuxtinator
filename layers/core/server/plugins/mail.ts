// Builds the mail kernel. Registers the first-party providers and core's two
// streams, then, once every plugin has run and migrations have finished,
// builds the instance, syncs the env account and starts the outbox sweep.
// A build that throws stops the process: a bad mail configuration should
// fail the boot, not the first password reset.
import { Cron } from 'croner'
import { mailgunProvider, sendgridProvider, sesProvider } from '@nuxtinator/mail/adapters'
import { memoryDns } from '@nuxtinator/mail/kernel'
import { createFakeProvider } from '@nuxtinator/mail/test'
import { db } from '#core/server/utils/database'
import { createPgPool } from '#core/server/utils/db-connection'
import { migrationsReady } from '#core/server/utils/migration-status'
import { buildMail, mailIfBuilt, registerMailProvider, registerMailStream, settleMail } from '#core/server/utils/mail'
import { mailFakeState, notifyMailAlert } from '#core/server/utils/mail-host'
import { getSiteUrl } from '#core/server/utils/site-url'

function fromLocal(): string {
  const from = (process.env.SMTP_FROM || '').trim()
  const at = from.lastIndexOf('@')
  return at > 0 ? from.slice(0, at) : 'noreply'
}

export default defineNitroPlugin((nitroApp) => {
  if (process.env.NUXT_PREPARE_BUILD || process.env.NITRO_PRESET === 'prepare') return

  registerMailProvider(mailgunProvider)
  registerMailProvider(sesProvider)
  registerMailProvider(sendgridProvider)
  if (process.env.MAIL_FAKE_PROVIDER === '1') {
    const fake = createFakeProvider()
    mailFakeState.provider = fake
    mailFakeState.dns = memoryDns()
    registerMailProvider(fake)
  }

  // Mail the person just asked for skips suppressions; everything else
  // core sends (invites, notifications, share notices) respects them.
  registerMailStream({ id: 'account', label: 'Account', defaultLocal: fromLocal(), orgAssignable: false, userInitiated: true, queued: true })
  registerMailStream({ id: 'system', label: 'System', defaultLocal: fromLocal(), orgAssignable: false, queued: true })

  const build = async () => {
    const outcome = await migrationsReady()
    if (!outcome.database) {
      console.warn('[mail] no database: the mail kernel is not built and mail is unavailable')
      settleMail(null)
      return
    }
    const secretKey = process.env.NUXT_SECRET_ENCRYPTION_KEY || String(useRuntimeConfig().secretEncryptionKey || '') || undefined
    if (!secretKey) {
      console.error('[mail] NUXT_SECRET_ENCRYPTION_KEY is not set: this process can only enqueue mail, and nothing will be sent')
    }
    const listenUrl = process.env.MAIL_LISTEN_DATABASE_URL
    const mail = buildMail({
      db,
      env: process.env,
      secretKey,
      outboxPublicKey: process.env.MAIL_OUTBOX_PUBLIC_KEY || undefined,
      webhookSecret: process.env.MAIL_WEBHOOK_SECRET || undefined,
      sweepSeconds: Number.parseInt(process.env.MAIL_SWEEP_SECONDS || '30', 10),
      dns: mailFakeState.dns ?? undefined,
      subscribe: listenUrl
        ? (channel, onNotify) => {
            // LISTEN needs a session: a direct connection, never the pooled `db`.
            const listener = createPgPool(listenUrl, { max: 1 })
            void listener.listen(channel, () => onNotify())
            nitroApp.hooks.hook('close', async () => {
              await listener.end({ timeout: 2 })
            })
          }
        : undefined
    })
    if (secretKey) await mail.syncEnvAccount()
    settleMail(mail)
    mail.startSweeping()
    if (secretKey) void mail.runOutboxSweep().catch(err => console.error('[mail] first outbox sweep failed:', err))
  }

  // After every plugin's synchronous setup, so all registrations are in.
  setImmediate(() => {
    build().catch((err) => {
      console.error('[mail] the mail kernel could not be built:', err)
      settleMail(null, err)
      process.exit(1)
    })
  })

  nitroApp.hooks.hook('close', async () => {
    await mailIfBuilt()?.stop()
  })

  new Cron('17 4 * * *', { protect: true }, async () => {
    const mail = mailIfBuilt()
    if (!mail?.canSend) return
    try {
      await mail.admin.runDailyJob({ baseUrl: getSiteUrl(), onAlert: notifyMailAlert })
      await mail.purgeOutbox()
    } catch (err) {
      console.error('[mail] daily job failed:', err)
    }
  })
})
