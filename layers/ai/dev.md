# AI layer — maintainer notes

Working doc for `@nuxtinator/ai`. [README.md](README.md) is the consumer overview.
This is the shared AI backend built for Phase 10a of the inbox plan
([../apps/inbox/PLAN.md](../apps/inbox/PLAN.md)); the inbox is its first consumer
(Phase 10b), the context assistant its second.

## Decisions (what we chose and why)

- **OpenRouter, plain `fetch`, no SDK.** OpenRouter is OpenAI-compatible, so the
  client is a plain `fetch` to `/chat/completions`. This deliberately sidesteps
  the `@anthropic-ai/sdk` bundling pain the `context` layer hit (its
  `nitro.externals.inline` + shim workaround).
- **Mirrors `#email` exactly.** The real impl lives in this layer and registers
  `#ai/server` unconditionally ([modules/ai-alias.ts](modules/ai-alias.ts)); core
  ships a throwing fallback ([../core/ai-fallback/ai.ts](../core/ai-fallback/ai.ts))
  registered by [../core/modules/ai-kernel.ts](../core/modules/ai-kernel.ts) only
  if unset. So consumers import `#ai/server` unconditionally and gate on
  `isAiConfigured(tx)` — AI is optional at both the layer and key level.
- **Shared types are canonical in core.** [../core/ai-fallback/types.ts](../core/ai-fallback/types.ts)
  owns the `#ai/server` type surface (pure types, no runtime, outside
  `server/utils/` so auto-import ignores it) so the fallback and the real impl
  can't drift. Both `export * from` it.
- **`generate()` = forced single tool call.** OpenRouter tool calling replaces
  Anthropic's `tool_choice: {type:'tool'}`. `generate` forces one tool
  (`tool_choice: {type:'function', function:{name}}`) and returns the parsed
  arguments — the structured-output pattern for drafting/extraction. `length`
  finish-reason throws "cut off" (a truncated forced-tool response is partial
  JSON, not an error).
- **Consumers pass `tx` + `feature`, never a key or model.** `complete` /
  `generate` resolve both themselves ([server/utils/ai-settings.ts](server/utils/ai-settings.ts)).
  The only way to run on the host's key is "this org has none" — no call path
  can spend the host's budget by forgetting an argument.
- **Per-provider keys, org key over host key.** An org stores its own key per
  provider on `/@<slug>/settings/ai` (encrypted with core's secret-crypto,
  verified against the provider before storing, never returned to the
  browser). Orgs without one use the host's key for that provider: the env var
  when set, else one stored on `/admin/ai`. A provider whose env key is set
  can't have a host key stored (409) — the env always wins.
- **Whose key decides the allowed set, per provider.** On the host's key an org
  may only pick that provider's host-enabled models (the host controls what
  its budget runs). On its own key it picks from the models it enabled for that
  provider (org-scope `enabled_models`), so apps can offer the org's own
  shortlist.
- **Nothing model-specific in code.** The live OpenRouter list
  ([server/utils/ai-model-list.ts](server/utils/ai-model-list.ts), public
  `GET /models`, cached an hour, stale-while-revalidate, tool-capable only) is
  the sole source of names, prices, context windows and capability flags
  (`temperature` from `supported_parameters`, caching from cache-read pricing).
  No default-enabled ids, no default model id: a fresh deployment has nothing
  enabled until an operator picks. Model ids in code go stale fast.
- **Two settings scopes that stack.** Host (`core_host_settings`, edited on
  `/admin/ai`): `enabled_models`, `default_model`, `feature_models`. Org
  (`core_settings`, RLS-scoped, edited on the org page): `<provider>_api_key`,
  `enabled_models`, `default_model`, `feature_models`. Host keys live in
  `core_host_settings` under the same `<provider>_api_key` names. One `registerSetting` per key serves both
  tables. Resolution for a feature: org choice → org default → host choice →
  host default, skipping anything the org may not use right now. Stored choices
  are never deleted on fallback; the pickers mark them unavailable.
- **Org settings shell is extensible via a core registry.** The tenancy settings
  sidebar is a hardcoded list plus everything in core's
  `org-settings-section-registry` (served by `/api/o/<slug>/_settings-sections`,
  permission-filtered). This layer registers `ai` → `/@<slug>/settings/ai` and
  ships the page at `app/pages/@[orgSlug]/settings/ai.vue`, which Nuxt nests
  under tenancy's `settings.vue` because page dirs merge across layers. Gated on
  `org.settings.write` like its sibling tabs.
- **Host page gated on operator-admin, no org context.** `/admin/ai` reads and
  writes the deployment-global store with plain `db` — the `/admin` area is never
  org-prefixed, so its requests carry no X-Active-Org and `withOrgContext` would
  404 there. Its "effective" values are therefore the host chain only.

- **Provider routing by id prefix.** Model ids `tinfoil/…`, `openai-api/…`
  and `anthropic-api/…` route to those providers; everything else is
  OpenRouter ([server/utils/ai-provider.ts](server/utils/ai-provider.ts)). The
  direct prefixes are deliberately not `openai/`/`anthropic/`, which are
  OpenRouter vendor slugs.
- **Tinfoil.** Requests go
  through the SDK's attested, body-encrypting `SecureClient.fetch`
  ([server/utils/tinfoil-client.ts](server/utils/tinfoil-client.ts)), with the
  org's or host's key per request. The catalog is the JSON Tinfoil's pricing page reads
  (`api.tinfoil.sh/api/config/models`, undocumented) parsed by
  [server/utils/tinfoil-models.ts](server/utils/tinfoil-models.ts): tool-capable
  chat models plus file-upload transcription models, with prices, image
  support and the per-model request fragments that switch reasoning on/off.
  Embeddings stay on OpenRouter.
- **OpenAI and Anthropic direct, no SDKs.** OpenAI is OpenAI-compatible
  (`max_completion_tokens`, `reasoning_effort`, no `cache_control`). Anthropic
  goes through a translation layer
  ([server/utils/anthropic-messages.ts](server/utils/anthropic-messages.ts),
  pure, unit-tested) over the Messages API; the tool loop carries Anthropic's
  raw content blocks (`native`) on assistant turns so thinking blocks go back
  unchanged. Catalogs need a key, so they load with whichever org or host key
  is in hand ([server/utils/direct-models.ts](server/utils/direct-models.ts));
  both lean on OpenRouter's catalog for prices.
- **Model kinds.** Models are `chat` or `transcription`; features declare a
  `kind` (default chat, or `embedding` for a vector index). Transcription
  features resolve org choice → host choice only (the default model is a chat
  model). Pickers and the config PUTs enforce kind.
- **Layer-only types.** Image parts, reasoning levels, provider/kind fields
  and `transcribe` types live in [types/ai-ext.ts](types/ai-ext.ts), on top of
  core's `#core/ai-fallback/types` (the surface the throwing fallback shares).

## Gotchas (hard-won)

1. **Adding routes can trip TS2589 elsewhere.** This layer's `/api/ai/*` routes
   enlarged the typed-route union enough to tip two already-borderline `$fetch`
   call sites (`layers/apps/inbox/.../useInboxRecordConversations.ts`,
   `layers/core/server/utils/layer-updates.ts`) over TypeScript's instantiation
   depth limit. Fix: pin the request generic to `string`
   (`$fetch<T, string>(...)`) so `$fetch` resolves against the fallback branch
   instead of deep-walking the route union. Watch for this when adding endpoints.
2. **VITEST short-circuits at the network boundary.** `isAiConfigured(tx)` returns
   true under VITEST (no key needed); `generate`/`complete` route to the
   primeable fake in [server/utils/ai-test-fake.ts](server/utils/ai-test-fake.ts);
   the model list is the fixed `AI_TEST_MODELS` (alpha/beta/gamma, plus the
   `test/whisper` transcription model); `validateApiKey`
   accepts anything but the literal `invalid`; a feature with nothing configured
   runs on `test/alpha` so consumer suites need no host config. Unprimed,
   `complete` returns `[[stub:<model>]]` and `generate` a schema-shaped stub.
3. **New server files need a dev-server restart** (Nitro's dev scan misses files
   created after boot — the register plugin silently won't run). Same as every
   other layer.
4. **`NUXT_SECRET_ENCRYPTION_KEY` must be set** wherever an org will store a key;
   `setOrgApiKey` surfaces the missing-key error as a 500 with the reason.
   Rotating it makes every stored org key `undecryptable` — the org page shows
   the state and offers Remove; generation for that org errors rather than
   silently falling back to the host key.
5. **Empty model list ≠ no models.** If OpenRouter is unreachable since boot the
   list is empty; `isKnownModel` then passes every id so stored choices keep
   working, and the pages show a "model list unavailable" notice instead of
   emptying the pickers.

6. **Whisper's `prompt` drops text on Tinfoil.** With a vocabulary prompt,
   `whisper-large-v3-turbo` returned only the last sentence of a clip that
   transcribes fully without one. Don't pass `prompt` to it. `voxtral-small-24b`
   accepts `.m4a` despite the docs listing mp3/wav only.
7. **Bundle the Tinfoil SDK.** Left external, Nitro hoists its
   `@noble/hashes` 2.x over the 1.x another dependency needs and the server
   crashes at boot (`ERR_PACKAGE_PATH_NOT_EXPORTED ./crypto`). nuxt.config
   inlines the SDK and its crypto stack.
8. **All orgs share one Tinfoil prompt-cache scope** (one host key, one
   `userCacheSecret`). Per-org scoping (a per-org `user_cache_secret` in the
   body) is needed before this serves orgs that mustn't observe each other's
   cache timing.

## Files

- Client: [server/utils/ai-client.ts](server/utils/ai-client.ts) (OpenRouter/Tinfoil requests,
  key/model resolution, key verification, error map) · env config
  [server/utils/ai-config.ts](server/utils/ai-config.ts) · tool loop
  [server/utils/ai-tool-loop.ts](server/utils/ai-tool-loop.ts) (pure, unit-tested)
  · stream reader [server/utils/ai-stream.ts](server/utils/ai-stream.ts) (pure, unit-tested)
  · VITEST fake [server/utils/ai-test-fake.ts](server/utils/ai-test-fake.ts)
  + control route [server/routes/api/_test/ai.ts](server/routes/api/_test/ai.ts)
  · live model list [server/utils/ai-model-list.ts](server/utils/ai-model-list.ts)
  · settings + resolution [server/utils/ai-settings.ts](server/utils/ai-settings.ts)
  · feature registry [server/utils/ai-feature-registry.ts](server/utils/ai-feature-registry.ts)
  · provider routing [server/utils/ai-provider.ts](server/utils/ai-provider.ts)
  · Anthropic translation [server/utils/anthropic-messages.ts](server/utils/anthropic-messages.ts) (pure, unit-tested)
  · OpenAI/Anthropic catalog parsers [server/utils/direct-models.ts](server/utils/direct-models.ts) (pure, unit-tested)
  · Tinfoil transport [server/utils/tinfoil-client.ts](server/utils/tinfoil-client.ts)
  + catalog parser [server/utils/tinfoil-models.ts](server/utils/tinfoil-models.ts) (pure, unit-tested).
- Barrel: [server/exports/index.ts](server/exports/index.ts) (`#ai/server`) ·
  client types [app/utils/ai-manifest.ts](app/utils/ai-manifest.ts) (`#ai`).
- Boot: [server/plugins/register-ai.ts](server/plugins/register-ai.ts) (settings,
  admin section, org settings section).
- Endpoints: [server/routes/api/ai/models.get.ts](server/routes/api/ai/models.get.ts)
  · [server/routes/api/ai/admin/config.{get,put}.ts](server/routes/api/ai/admin/)
  · [server/routes/api/ai/admin/key.{put,delete}.ts](server/routes/api/ai/admin/)
  · [server/routes/api/ai/org/config.{get,put}.ts](server/routes/api/ai/org/)
  · [server/routes/api/ai/org/key.{put,delete}.ts](server/routes/api/ai/org/)
  · [server/routes/api/ai/status.get.ts](server/routes/api/ai/status.get.ts).
- UI: [app/components/AiModelSelect.vue](app/components/AiModelSelect.vue)
  (searchable picker) · [app/components/AiProviderKey.vue](app/components/AiProviderKey.vue)
  (one provider's key) · [app/components/AiModelList.vue](app/components/AiModelList.vue)
  · [app/utils/ai-model-meta.ts](app/utils/ai-model-meta.ts)
  · host page [app/pages/admin/ai/index.vue](app/pages/admin/ai/index.vue)
  · org page [app/pages/@[orgSlug]/settings/ai.vue](app/pages/@[orgSlug]/settings/ai.vue).
- Tests: [tests/unit/ai-model-list.test.ts](tests/unit/ai-model-list.test.ts) (parser)
  · [tests/unit/ai-tool-loop.test.ts](tests/unit/ai-tool-loop.test.ts) (pure)
  · [tests/unit/ai-stream.test.ts](tests/unit/ai-stream.test.ts) (pure)
  · [tests/unit/tinfoil-models.test.ts](tests/unit/tinfoil-models.test.ts) (Tinfoil catalog parser)
  · [tests/api/ai-admin.test.ts](tests/api/ai-admin.test.ts) (host endpoints,
  gating, validation, cross-org sharing)
  · [tests/api/ai-org.test.ts](tests/api/ai-org.test.ts) (org key lifecycle,
  allowed set, resolution chain, isolation, audit).

## Consumers

- inbox — `generate` for draft replies and knowledge extraction.
- context — `complete` with `load_section` / `load_portfolio` tools for the
  portfolio assistant (feature `context.assistant`).

## Follow-ups

- Real generation is only exercisable with a key set (tests use the VITEST
  stub). Smoke-test live once a key is wired.
