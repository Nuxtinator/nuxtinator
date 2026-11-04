// Public contact-form intake: API-key auth (identifies the org), a submission
// becoming a source='contact_form' conversation with a first inbound message
// and a first-line subject fallback, the 401/400 rejections, and the
// address-confirmation link an unverified sender gets in the auto-ack.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  setInboxOrgSetting,
  postInbound,
  waitForMailTo
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

// Subjects of every captured mail to an address (Mailpit search — exact
// recipient match, unaffected by other projects' parallel mail volume).
async function mailSubjectsTo(email: string): Promise<string[]> {
  const base = process.env.TEST_MAILHOG_URL || 'http://localhost:8025'
  const res = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`)
  const body = await res.json() as { messages: Array<{ Subject: string, To: Array<{ Address: string }> }> }
  return (body.messages ?? [])
    .filter(m => m.To.some(t => t.Address.toLowerCase() === email.toLowerCase()))
    .map(m => m.Subject)
}

describe('contact form', () => {
  it('creates a source=contact_form conversation from a submission', async () => {
    const { org, opts } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)

    const res = await $fetch<{ status: string, conversationId: string }>('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email: 'visitor@example.com', name: 'Visitor', message: 'Hello there\nI have a question' }
    })
    expect(res.status).toBe('received')

    const detail = await $fetch<{
      conversation: { source: string, subject: string | null }
      messages: Array<{ direction: string }>
    }>(`/api/inbox/conversations/${res.conversationId}`, opts)
    expect(detail.conversation.source).toBe('contact_form')
    expect(detail.conversation.subject).toBe('Hello there')
    expect(detail.messages.some(m => m.direction === 'inbound')).toBe(true)
  })

  it('survives a staff-notify failure — the submission is stored and the POST still succeeds', async () => {
    const { org } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)

    const res = await $fetch<{ status: string, conversationId: string }>('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'x-test-fail': 'notify' },
      body: { email: 'visitor@example.com', name: 'Visitor', message: 'This submission must survive' }
    })
    expect(res.status).toBe('received')

    const conversations = await sql`SELECT id FROM inbox_conversations WHERE id = ${res.conversationId}`
    expect(conversations.length).toBe(1)
    const messages = await sql`SELECT id FROM inbox_messages WHERE conversation_id = ${res.conversationId}`
    expect(messages.length).toBe(1)
  })

  it('rejects a missing or wrong API key with 401', async () => {
    const { org } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', `test-inbox-key-${randomUUID()}`)
    await expect(
      $fetch('/api/inbox/contact', { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: { email: 'a@b.com', message: 'hi' } })
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      $fetch('/api/inbox/contact', { method: 'POST', body: { email: 'a@b.com', message: 'hi' } })
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a malformed email with 400', async () => {
    const { org } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)
    await expect(
      $fetch('/api/inbox/contact', { method: 'POST', headers: { 'x-api-key': apiKey }, body: { email: 'nope', message: 'hi' } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('grants marketing consent through the CRM kernel when the checkbox is set, with the normalized country as evidence', async () => {
    const { org } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)
    const email = `test-inbox-consent-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch<{ status: string }>('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email, message: 'Sign me up', consent: true, country: 'DEU' }
    })
    expect(res.status).toBe('received')

    const [consent] = await sql`
      SELECT cc.purpose, cc.status, cc.source, cc.capture_meta FROM crm_channel_consents cc
      JOIN crm_channels ch ON ch.id = cc.channel_id WHERE ch.value = ${email}
    `
    expect(consent!.purpose).toBe('marketing')
    expect(consent!.status).toBe('opt_in')
    expect(consent!.source).toBe('contact_form')
    expect((consent!.capture_meta as { country?: string }).country).toBe('DE')

    const [event] = await sql`
      SELECT e.event, e.actor_user_id, e.source FROM crm_consent_events e
      JOIN crm_channels ch ON ch.id = e.channel_id WHERE ch.value = ${email}
    `
    expect(event!.event).toBe('grant')
    expect(event!.actor_user_id).toBeNull()
    expect(event!.source).toBe('contact_form')
  })

  it('asks an unverified sender to confirm their address in the auto-ack; the link verifies once', async () => {
    const { org } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)
    const email = `test-inbox-verify-${randomUUID().slice(0, 8)}@example.com`

    await $fetch('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email, name: 'Vera', message: 'Please confirm me' }
    })

    const ack = await waitForMailTo(email, 15_000)
    expect(ack.subject.toLowerCase()).toContain('confirm')
    const link = ack.body.match(/\/api\/inbox\/verify\/([a-f0-9]{48})/)
    expect(link).toBeTruthy()
    const token = link![1]!

    const [before] = await sql`SELECT verified, verification_token_hash FROM crm_channels WHERE value = ${email}`
    expect(before!.verified).toBe(false)
    expect(before!.verification_token_hash).toBeTruthy()

    const page = await $fetch<string>(`/api/inbox/verify/${token}`)
    expect(page).toContain('Email confirmed')
    const [after] = await sql`SELECT verified, verification_token_hash FROM crm_channels WHERE value = ${email}`
    expect(after!.verified).toBe(true)
    expect(after!.verification_token_hash).toBeNull()

    // Single use: the same link is dead now.
    await expect($fetch(`/api/inbox/verify/${token}`)).rejects.toMatchObject({ statusCode: 410 })
  })

  it('sends the plain ack, with no confirmation link, to an already-verified address', async () => {
    const { org, domain } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)
    const email = `test-inbox-known-${randomUUID().slice(0, 8)}@sender.example`
    // Authenticated inbound mail from the address proves ownership first.
    await postInbound({ recipient: `hello@${domain}`, from: `K <${email}>` })

    await $fetch('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email, message: 'Just checking in' }
    })

    const [channel] = await sql`SELECT verified, verification_token_hash FROM crm_channels WHERE value = ${email}`
    expect(channel!.verified).toBe(true)
    expect(channel!.verification_token_hash).toBeNull()

    // The inbound auto-ack ("Re: Test subject") and the form ack both land;
    // neither asks for confirmation.
    let subjects: string[] = []
    for (let i = 0; i < 30 && !subjects.some(s => s.includes('Just checking in')); i++) {
      await new Promise(r => setTimeout(r, 500))
      subjects = await mailSubjectsTo(email)
    }
    expect(subjects).toContain('Re: Just checking in')
    expect(subjects.some(s => s.toLowerCase().includes('confirm'))).toBe(false)
  })

  it('records no consent without the checkbox, and an unknown country never rejects the submission', async () => {
    const { org } = await createInboxOrgWith(sql)
    const apiKey = `test-inbox-key-${randomUUID()}`
    await setInboxOrgSetting(sql, org.id, 'contact_form_api_key', apiKey)
    const email = `test-inbox-noconsent-${randomUUID().slice(0, 8)}@example.com`

    const res = await $fetch<{ status: string }>('/api/inbox/contact', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: { email, message: 'Just a question', country: 'NOT_A_COUNTRY' }
    })
    expect(res.status).toBe('received')

    const rows = await sql`
      SELECT cc.id FROM crm_channel_consents cc
      JOIN crm_channels ch ON ch.id = cc.channel_id WHERE ch.value = ${email}
    `
    expect(rows.length).toBe(0)
  })
})
