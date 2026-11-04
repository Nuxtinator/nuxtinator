// POST /api/inbox/contact — public, server-to-server contact-form intake.
// No session, no CORS: the request is authorized by an API key (X-API-Key or a
// Bearer token) that ALSO identifies which org the submission belongs to. The
// submission becomes a source='contact_form' conversation with the message as
// its first inbound message; staff are notified and an auto-ack is sent. An
// unverified address gets a confirmation link in that ack (a form proves
// nothing about ownership; a click does). The submission is never lost to a
// notification/courtesy failure — those are best-effort and swallowed.
import { z } from 'zod'
import { getClientIp } from '#core/server/utils/client-ip'

const Body = z.object({
  email: z.string().email(),
  name: z.string().max(300).optional(),
  subject: z.string().max(500).optional(),
  message: z.string().min(1).max(500_000),
  // An explicit marketing-consent checkbox on the form. Only `true` grants;
  // absent/false records nothing (consent is never inferred from submitting).
  consent: z.boolean().optional(),
  // ISO 3166-1 alpha-2 or alpha-3; normalized to alpha-2. Anything unknown or
  // malformed becomes null — a bad country never rejects the submission.
  country: z.string().max(64).optional()
})

export default defineEventHandler(async (event) => {
  const key = getHeader(event, 'x-api-key')
    || (getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '')
  const scope = key ? await inboxResolveOrgForApiKey(key) : undefined
  if (scope === undefined) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid API key' })
  }

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid submission', data: parsed.error.flatten() })
  }
  const { email, name, subject, message, consent } = parsed.data

  const created = await inboxWithScopeTx(scope, tx => inboxRecordIntake(tx, {
    email,
    name: name ?? null,
    subject: subject ?? null,
    message,
    source: 'contact_form',
    consent,
    country: inboxNormalizeCountry(parsed.data.country),
    ip: getClientIp(event),
    userAgent: getHeader(event, 'user-agent') ?? null
  }))

  await inboxAfterIntake(scope, created, {
    // Test seam (VITEST only): fail the notify so the suite can pin that the
    // stored submission survives a notification failure.
    beforeNotify: () => {
      if (process.env.VITEST && getHeader(event, 'x-test-fail') === 'notify') {
        throw new Error('Injected notify failure')
      }
    }
  })

  return { status: 'received', conversationId: created.conversationId }
})
