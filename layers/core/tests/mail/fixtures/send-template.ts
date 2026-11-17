// POST /api/test-core-mail/send-template { to, template } — sends one core
// template through `#email`, for the stream-per-template tests.
import { defineEventHandler, readBody } from 'h3'
import { sendTemplateEmail } from '#email'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) as { to: string, template: Parameters<typeof sendTemplateEmail>[0]['template'] }
  const ok = await sendTemplateEmail({
    to: body.to,
    template: body.template,
    data: {
      userName: 'Test',
      inviterName: 'Inviter',
      resetUrl: 'https://app.test/reset?token=t',
      verifyUrl: 'https://app.test/verify?token=t',
      inviteUrl: 'https://app.test/accept-invite?token=t',
      title: 'Hello',
      message: 'Hello'
    } as never
  })
  return { ok }
})
