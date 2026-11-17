// @nuxtinator/mail/adapters — the first-party providers, as plain objects.
export { mailgunProvider, mapMailgunEvent } from './mailgun'
export { sendgridProvider, mapSendgridEvent, verifySendgridSignature, SENDGRID_CAPABILITY_SCOPES } from './sendgrid'
export { sesProvider, mapSesEvent } from './ses'
