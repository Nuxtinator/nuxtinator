# MCP Layer Tests

```
tests/
  setup.ts                    # Vitest per-test setup (Nitro globals + state reset)
  global-setup.ts             # Vitest globalSetup — truncates test tables once before suite
  harness.ts                  # Integration harness (createTestUser, callMcp, etc.)
  stubs/                      # Test stubs for #core/* and #oauth/* aliases (unit suite only)
    app/utils/permissions.ts
    server/utils/{rbac, activity-logger, oauth-bearer, oauth-config, permissions-registry, scopes-registry}.ts
    server/database/schema.ts
    nitro-globals.ts          # useStorage / useRuntimeConfig / createError shims
  unit/                       # Unit tests — no Nuxt boot, no DB
    registry.test.ts
    errors.test.ts
    validate.test.ts
    rate-limit.test.ts
    origin.test.ts
    semver.test.ts
  integration/                # Boots fixture consumer with @nuxt/test-utils/e2e
    transport.test.ts
  fixtures/
    consumer/                 # Real Nuxt app extending core + oauth + mcp layers
      nuxt.config.ts
      server/mcp-tools/all.ts
      server/plugins/10-mcp-test-tools.ts   # registers pages.* perms, roles, tools
```

## Running

```bash
cd layers/mcp
TEST_DATABASE_URL=postgres://<user>@localhost:5432/mcp_layer_test \
NUXT_PUBLIC_SITE_URL=http://localhost:3099 \
bun run test
```

The integration suite needs:

- A clean Postgres database. Create once: `createdb mcp_layer_test`.
- `TEST_DATABASE_URL` pointed at it.
- `NUXT_PUBLIC_SITE_URL` matching the harness's resource URI (default `http://localhost:3099`).

The schema comes from core's migration runner, which applies core + OAuth
migrations when the fixture consumer boots. The `global-setup.ts` hook
truncates the test tables `RESTART IDENTITY CASCADE` before the suite so the
run starts clean (on a fresh database the tables don't exist yet and it
skips them).

Per-test isolation runs through the harness's `cleanupFixtures()` —
called from `afterEach` in the integration spec.

## Coverage (Phase L4 acceptance)

**Unit (47 tests across 6 files)**:
- `registry.test.ts` (10) — register, duplicate-name (prod throws / dev replaces),
  JSON-Schema cache, scope-not-in-PERMISSIONS reject, `__resetForTests()`
  prod-guard, resource registration.
- `errors.test.ts` (9) — Zod-flatten, h3 400/403/404/409 mapping, 5xx/unknown
  collapse to "Internal error" without leaking stack traces.
- `validate.test.ts` (3) — happy path, ZodError on bad payload, `.strict()`
  rejects unknown keys.
- `rate-limit.test.ts` (12) — defaults, partial override, explicit-null
  disables, cache identity, per-token arithmetic, read-scope detection,
  writes bucket, destructive-per-user, per-tool override, dry-run /
  no-double-charge invariant, retryAfterSeconds bound.
- `origin.test.ts` (6) — absent / resource-origin / dev-localhost /
  prod-localhost / additional-origins paths.
- `semver.test.ts` (7) — equal / older / newer, pre-release < release,
  pre-release tiebreak, the `1.20.0-alpha < 1.20.0` regression test for
  the SDK floor check.

**Integration (20 tests in transport.test.ts)** — boots the fixture
consumer + drives the live `/mcp` route over $TEST_DATABASE_URL:

- `GET /mcp` returns 405 with `Allow: POST`.
- `DELETE /mcp` returns 405.
- POST without bearer returns 401.
- POST with hostile Origin returns 403.
- POST with body > 2 MB returns 413.
- post-initialize POST without `MCP-Protocol-Version` is accepted.
- POST with an unsupported `MCP-Protocol-Version` returns 400.
- POST with malformed JSON returns 400.
- `tools/list` filters to scope ∩ RBAC.
- `tools/list` hides write tools when token has only read scope (even when
  user holds the write permission in RBAC).
- `tools/call` with token missing the scope → `isError` with structured
  payload `{ error: 'insufficient_scope', surface: 'token', actionable: 're_authorize' }`.
- `tools/call` with user RBAC missing the scope → `isError` with
  `{ error: 'insufficient_permission', surface: 'rbac', actionable: 'contact_admin' }`.
- Output-schema validation rejects malformed `structuredContent` and emits
  `mcp.handler_output_invalid` server-side.
- Output-schema validation accepts a valid `structuredContent`.
- `structuredContent` (success and authorization errors) is also returned
  serialized as a trailing text block.
- `tools/call` with handler throwing 404 maps to `isError "page not found"`.
- A successful write tool emits an `mcp`-source `activity_logs` row with
  the standard metadata shape (source, client_id, tool, scope, user_id).
- Per-tool rate limit exhaustion returns `isError` (not HTTP 429).
- `initialize` succeeds with a valid bearer; `serverInfo.name` matches the
  fixture's `runtimeConfig.mcpServerName`.

## Architecture

The harness runs in the Vitest process. The fixture consumer boots in a
separate Node child process via `@nuxt/test-utils/e2e`'s `setup()`. Both
processes connect to the same Postgres at `TEST_DATABASE_URL`.

`callMcp()` uses `globalThis.fetch` against the booted server's URL
(via `@nuxt/test-utils`'s `url()` helper) — `ofetch` and friends mangle
Streamable-HTTP responses, so we go raw.

`issueTestToken()` writes the `oauth_token_families` + `oauth_access_tokens`
rows directly using its own Kysely client. It doesn't import from the OAuth
layer's `oauth-test.ts` because that module's `~~/server/utils/database`
imports only resolve inside the fixture process.

`cleanupFixtures()` walks the FK graph in safe order (refresh_tokens →
access_tokens → … → users) and deletes only the rows the harness tracked
during the test, plus all `mcp`-source `activity_logs` rows.
