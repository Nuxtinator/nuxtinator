// Messages for the `auth_error` codes provider sign-in flows redirect back
// with. Codes only — never reflect text from the URL into the page.
const MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  failed: 'Sign-in failed. Please try again.',
  email_unverified: 'Your email address with that provider isn\'t verified, so it can\'t be used to sign in here.',
  unverified_account: 'An account with this email exists but hasn\'t been verified. Sign in with your password (or reset it), then link this sign-in method from Account Settings.',
  already_linked: 'That account is already linked to a different user.',
  one_per_provider: 'An account from that provider is already linked. Unlink it first.',
  invite_invalid: 'That invitation is no longer valid.'
}

export function authErrorMessage(code: unknown): string {
  if (typeof code !== 'string' || !code) return ''
  return MESSAGES[code] ?? MESSAGES.failed!
}
