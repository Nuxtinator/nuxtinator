# @nuxtinator/email-mailgun (retired)

This layer is empty. Mail now goes through the provider-neutral mail kernel,
`@nuxtinator/mail`, which core loads and which ships the Mailgun, SES and
SendGrid providers.

To move a host over:

1. In `layers.ts`, replace the `email-mailgun` entry with
   `{ id: 'mail', pkg: '@nuxtinator/mail', repo: 'Nuxtinator/nuxtinator', subdir: 'layers/mail' }`
   and raise core to `^4`.
2. Keep `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (and `MAILGUN_HOST` in the EU) in
   the runtime environment. They become the "Environment" account and domain
   on `/admin/email`.

The full cutover steps are in `documentation/layers.md` under "Mail".
