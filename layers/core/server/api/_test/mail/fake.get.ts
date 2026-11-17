// Test-only view of the fake mail provider (MAIL_FAKE_PROVIDER=1); 404 otherwise.
import { requireMailFakeProvider } from '#core/server/utils/mail-host'

export default defineEventHandler((event) => {
  const fake = requireMailFakeProvider(event)
  return {
    sent: fake.sent.map(m => ({ to: m.to, from: m.from, domain: m.domain, subject: m.subject, messageId: m.messageId, correlation: m.correlation, bypassProviderSuppression: m.bypassProviderSuppression })),
    released: fake.released,
    provisioned: fake.provisioned,
    webhooksConfigured: fake.webhooksConfigured,
    control: { ...fake.control, hangFor: [...fake.control.hangFor] }
  }
})
