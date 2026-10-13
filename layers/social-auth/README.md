# @nuxtinator/social-auth

Sign in with Google and Sign in with Apple, for the web app and for native iOS/Android apps.

Each provider turns on when its credentials are set. With none set, the layer loads but does nothing. When a provider is configured, its button appears on `/login`, `/register` and `/accept-invite`, and under **Sign-in Methods** on `/account`.

## What happens when someone signs in

| Situation | Result |
|---|---|
| The provider account is already linked to a user | Signs in as that user. |
| No link yet, and the provider's verified email matches a verified user | Links the provider to that user and signs in. |
| The email matches a user who never verified their address | Refused (`auth_error=unverified_account`). Linking would hand the account to whoever registered the address first. That user signs in with their password (or resets it), then links the provider from `/account`. |
| The provider hasn't verified the email | Refused (`auth_error=email_unverified`). |
| No matching user | Creates a verified account with no password. If the provider sent no usable name (Apple sends it only on the first authorization, and not at all if the user declines), the browser goes to `/social-auth/complete` to ask for one. |
| No matching user, self-registration is off (**Admin → Settings**) and no invite | Refused (`auth_error=registration_closed`). |
| No matching user, self-registration is off, and the invite is expired or already used | Refused (`auth_error=invite_invalid`). |

The first account on a deployment becomes host admin, the same as with `/register`.

**Invites.** The accept-invite page passes the invite token through the flow. A new account accepts the invite as it is created. An existing account lands back on `/accept-invite`, signed in, and confirms "Join as …". The provider's email doesn't have to match the invited address.

**Hide My Email.** An Apple user who hides their email gets a `@privaterelay.appleid.com` address that never matches an existing account. They link Apple from `/account` while signed in. To email relay addresses, register your sending domain under Sign in with Apple → Email Communication in the Apple developer portal; mail to relay addresses is dropped otherwise.

**Avatars.** A Google profile photo becomes the avatar of a user who has none. The photo is copied to public S3 storage when `S3_*` and `S3_PUBLIC_BASE_URL` are configured; otherwise Google's URL is stored. Apple provides no photo.

**Account deletion.** For Apple identities, the refresh token is stored encrypted (this needs `NUXT_SECRET_ENCRYPTION_KEY`). Deleting the account or unlinking Apple revokes the app's access at Apple, which App Store review requires.

## Configuration

```
NUXT_SOCIAL_AUTH_GOOGLE_CLIENT_ID=          # OAuth client, type "Web application"
NUXT_SOCIAL_AUTH_GOOGLE_CLIENT_SECRET=
NUXT_SOCIAL_AUTH_GOOGLE_NATIVE_CLIENT_IDS=  # comma-separated iOS / Android client IDs

NUXT_SOCIAL_AUTH_APPLE_SERVICES_ID=         # Services ID (web)
NUXT_SOCIAL_AUTH_APPLE_TEAM_ID=
NUXT_SOCIAL_AUTH_APPLE_KEY_ID=              # key with "Sign in with Apple" enabled
NUXT_SOCIAL_AUTH_APPLE_PRIVATE_KEY=         # contents of the .p8 file; \n for newlines is fine
NUXT_SOCIAL_AUTH_APPLE_BUNDLE_IDS=          # comma-separated bundle IDs of your apps
```

Register these redirect URLs with each provider:

- Google: `<NUXT_PUBLIC_SITE_URL>/api/social-auth/google/callback`
- Apple (Services ID → Return URLs): `<NUXT_PUBLIC_SITE_URL>/api/social-auth/apple/callback`. Apple requires HTTPS and won't accept `localhost`; test the Apple web flow through a tunnel or a staging domain.

A provider's button (and its entry under Sign-in Methods) shows only when its web credentials are set. Native sign-in works with just the native IDs.

## Web flow

`GET /api/social-auth/:provider/start?intent=login|link|reauth&invite=…&redirect=/path`

- `login`: sign in or sign up.
- `link`: add the provider to the signed-in account (from `/account`).
- `reauth`: prove identity again before a sensitive action (core's step-up; see `useReauth`).

The flow state (state, nonce, PKCE verifier, intent) is kept in a signed, 10-minute, `HttpOnly` cookie. Apple returns with a cross-site form POST that doesn't carry `SameSite=Lax` cookies. `POST …/callback` re-issues it as a top-level GET to the same URL, and that GET does carry them. Errors return to `/login`, `/accept-invite` or `/account` with an `auth_error` / `link` code. The pages never echo text from the URL.

## Native apps

Sign in with the platform SDK (Google Sign-In, AuthenticationServices), then send the ID token:

```
POST /api/social-auth/native
X-Auth-Client: native
{
  "provider": "google" | "apple",
  "idToken": "…",
  "nonce": "…",                 // the raw nonce you passed to the SDK, if any
  "authorizationCode": "…",     // Apple: lets the server revoke access on account deletion
  "displayName": "…",           // Apple: the name from the first authorization, if you have it
  "invite": "…",                // an invite token the user opened in the app
  "intent": "login"             // or "link" / "reauth" with Authorization: Bearer <access token>
}
```

The response carries `accessToken`, `refreshToken` and `expiresIn`. Send the access token as `Authorization: Bearer`, and refresh it with `POST /api/auth/refresh { refreshToken }` (also with `X-Auth-Client: native`). See core's `server/utils/sessions.ts`.

- `422` with `data.needsDisplayName`: a new account needs a name. Ask the user, then call again with `displayName`.
- `409` with `data.code`: `unverified_account`, `email_unverified`, `already_linked` or `one_per_provider`.
- `403` with `data.code` `registration_closed`: no account matches and self-registration is off. Pass an `invite` to create one.
- `410` with `data.code` `invite_invalid`: as above, but the `invite` passed is expired or already used.
- `inviteNeedsConfirmation: true`: an existing account opened an invite. Confirm with `POST /api/auth/accept-invite { token }`.

Google ID tokens are accepted for the native client IDs and the web client ID; Android apps request tokens for the web client ID. Apple ID tokens are accepted for the bundle IDs.

## Tables

`user_identities`: one row per linked provider account (`provider`, `subject`, `email`, and for Apple the encrypted `refresh_token_enc` with the `client_id` that issued it). Unique on `(provider, subject)` and `(user_id, provider)`.
