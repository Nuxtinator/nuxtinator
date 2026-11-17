# @nuxtinator/mail

The provider-neutral mail kernel: sending-domain resolution, the outbox,
suppressions, inbound dispatch and provider events, plus the Mailgun, SES and
SendGrid adapters. It has no dependency on Nuxt or core; it takes a Kysely
instance and plain objects.

- `@nuxtinator/mail/kernel` — `createMail` and the types
- `@nuxtinator/mail/adapters` — `mailgunProvider`, `sesProvider`, `sendgridProvider`
- `@nuxtinator/mail/test` — `createFakeProvider` for tests

Nuxtinator apps don't build it themselves: core does, and layers register
streams and handlers through `#core/server/utils/mail`. Processes outside Nuxt
on the same database call `createMail` directly.

The guide is in [documentation/layers.md](../../documentation/layers.md#mail).
Tests: `cd dev && npx vitest run --project mail` (no Nuxt; runs in its own
Postgres schema).
