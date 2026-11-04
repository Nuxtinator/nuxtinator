// Contact-facing courtesy mail: the auto-acknowledgment for brand-new
// conversations and the "we received your message" notice for held senders.
// Both are best-effort fire-and-forget sends (a transient failure is logged,
// not retried — courtesy mail doesn't justify queue durability) and carry RFC
// 3834 autoReply headers so responders don't loop. Callers enforce the
// anti-backscatter gates: authenticated sender only, never to an
// auto-responder/bounce.

export interface InboxCourtesyContext {
  toEmail: string
  toName: string | null
  subject: string | null
  replyToken: string
  contactAddress: string
  // Display name on the courtesy From (the org's brand From name).
  brandName: string
  // Set when the sender's address is unverified: the ack then also asks them
  // to confirm it, so one email does both jobs (contact-form intake only —
  // authenticated inbound mail already proves ownership).
  verificationUrl?: string | null
  // Trusted HTML appended to the auto-ack after the standard body (e.g. a
  // help-chat transcript). Callers escape their own content.
  extraHtml?: string | null
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function ackBodyHtml(ctx: InboxCourtesyContext): string {
  const name = ctx.toName ? ` ${ctx.toName.split(/\s+/)[0]}` : ''
  const parts = [
    `<p>Hi${name},</p>`,
    `<p>Thanks for reaching out — your message has been received and someone from our team will get back to you soon.</p>`,
    `<p>You can reply directly to this email to add more details.</p>`
  ]
  if (ctx.verificationUrl) {
    const url = escapeAttr(ctx.verificationUrl)
    parts.push(
      `<p style="margin-top:20px;">Please confirm this is your email address so our reply reaches you:</p>`,
      `<p style="margin:20px 0;"><a href="${url}" style="background:#1f2933;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Confirm my email</a></p>`,
      `<p style="font-size:14px;color:#666666;word-break:break-all;">${url}</p>`
    )
  }
  if (ctx.extraHtml) parts.push(ctx.extraHtml)
  return parts.join('\n')
}

function heldBodyHtml(ctx: InboxCourtesyContext): string {
  const name = ctx.toName ? ` ${ctx.toName.split(/\s+/)[0]}` : ''
  return [
    `<p>Hi${name},</p>`,
    `<p>Your message has been received and is waiting for review by our team.</p>`
  ].join('\n')
}

export async function inboxSendCourtesy(
  kind: 'auto_ack' | 'held_sender',
  ctx: InboxCourtesyContext
): Promise<void> {
  const bodyHtml = kind === 'auto_ack' ? ackBodyHtml(ctx) : heldBodyHtml(ctx)
  const subject = kind === 'auto_ack' && ctx.verificationUrl
    ? 'Please confirm your email — we received your message'
    : (ctx.subject ? `Re: ${ctx.subject}` : `We received your message`)
  const result = await inboxSendEmail({
    from: inboxBuildFromAddress({ displayName: ctx.brandName || null, contactAddress: ctx.contactAddress }),
    to: ctx.toEmail,
    subject,
    html: inboxRenderMessageEmail({ bodyHtml, subject }),
    replyTo: inboxBuildReplyAddress(ctx.replyToken, ctx.contactAddress),
    autoReply: true
  })
  if (!result.success) {
    console.warn(`[inbox] ${kind} courtesy send to ${ctx.toEmail} failed: ${result.error}`)
  }
}
