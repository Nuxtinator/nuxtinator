// Builds the email sent when a board member replies to a feedback submitter.
// The reply leads with the member's message and quotes the submitter's
// original feedback underneath, the way a mail client quotes a thread.

export interface FeedbackReplyEmailInput {
  message: string
  senderName: string
  appName: string
  postMeta: Record<string, any>
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlLines(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>')
}

// The submitter's own fields, labeled and ordered the way the widget asked for
// them: a bug leads with its problem, an idea with the idea itself.
export function originalFeedbackParts(postMeta: Record<string, any>): { label: string, text: string }[] {
  const problem = typeof postMeta.problem_description === 'string' ? postMeta.problem_description.trim() : ''
  const fix = typeof postMeta.suggested_fix === 'string' ? postMeta.suggested_fix.trim() : ''
  const parts = postMeta.feedback_sub_type === 'idea'
    ? [{ label: 'Idea', text: fix }, { label: 'Problem it solves', text: problem }]
    : [{ label: 'Problem', text: problem }, { label: 'Suggested solution', text: fix }]
  return parts.filter(p => p.text)
}

function submittedOn(postMeta: Record<string, any>): string {
  const d = new Date(postMeta.submitted_at)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
}

export function buildFeedbackReplyEmail(input: FeedbackReplyEmailInput): { html: string, text: string } {
  const parts = originalFeedbackParts(input.postMeta)
  const when = submittedOn(input.postMeta)
  const wrote = when ? `On ${when}, you wrote:` : 'You wrote:'
  const pageUrl = typeof input.postMeta.page_url === 'string' ? input.postMeta.page_url : ''
  const footer = input.appName
    ? `Sent by ${input.senderName} (${input.appName}) in reply to your feedback.`
    : `Sent by ${input.senderName} in reply to your feedback.`

  const quotedHtml = parts
    .map(p => `<p style="margin: 0 0 12px 0;"><strong>${escapeHtml(p.label)}</strong><br>${htmlLines(p.text)}</p>`)
    .join('')
  const pageHtml = pageUrl
    ? `<p style="margin: 0; font-size: 12px;">Page: ${escapeHtml(pageUrl)}</p>`
    : ''

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #111827;">
      <div style="line-height: 1.6;">${htmlLines(input.message)}</div>
      <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 12px;">${escapeHtml(footer)}</p>
      <div style="margin-top: 24px; border-left: 4px solid #e5e7eb; padding: 4px 0 4px 16px; color: #4b5563;">
        <p style="margin: 0 0 12px 0; font-size: 13px;">${escapeHtml(wrote)}</p>
        ${quotedHtml}
        ${pageHtml}
      </div>
    </div>
  `

  const quotedText = parts
    .flatMap(p => [`${p.label}:`, ...p.text.split(/\r?\n/), ''])
    .concat(pageUrl ? [`Page: ${pageUrl}`] : [])
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')

  const text = `${input.message}\n\n${footer}\n\n${wrote}\n${quotedText}\n`

  return { html, text }
}
