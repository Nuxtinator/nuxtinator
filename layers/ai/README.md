# @nuxtinator/ai

An optional, shared AI backend any layer can consume. Four providers:
[OpenRouter](https://openrouter.ai) (one OpenAI-compatible API, many models),
Tinfoil (confidential inference), and OpenAI's and Anthropic's own APIs. The
host admin adds a key per provider, chooses which models the host's keys may
run and which model powers each AI feature; each organization can bring its
own key per provider, pick that provider's models, and override those choices.

## What you get

- **`#ai/server`** — server helpers for consumer layers:
  - `isAiConfigured(tx)` — can this org generate (its own key, or the host's
    fallback)? Gate your UI on this.
  - `complete({ tx, feature, … })` — chat completion → assistant text. Pass
    `tools` plus an `onToolCall` handler and the model may call them; each
    result is fed back and the loop ends on a text answer (or a forced one after
    `maxToolRounds`). Pass `onTextDelta` and the call streams: reply text
    arrives in fragments as it is written, and `onTextDiscard` fires when a
    round's text is superseded by tool calls so a consumer drops what it showed.
  - `generate({ tx, feature, tool, … })` — force a single tool call, return its
    parsed arguments as structured output (the pattern for AI-drafting,
    extraction, classification).
  - `decide({ tx, feature, input, questions })` — ask a decision model typed
    questions (yes/no, choice, score) about an input and get probabilities
    back instead of text (see [Decisions](#decisions)).
  - Both take the caller's `tx` and a feature key and resolve the key and model
    themselves: the org's own when it has them, the host's otherwise.
  - `resolveFeatureModel(tx, featureKey)` / `getAllowedModels(tx)` — the model a
    feature runs on for this org, and the models this org may pick.
  - `registerAiFeature({ key, label })` — declare a capability so it appears in
    the model pickers.
- **Admin → AI** page (`/admin/ai`, operator-admin) — a tab per provider with
  its host key (read-only when set in the env) and the models enabled for it;
  the host default and the model per feature.
- **Org settings → AI** page (`/@<slug>/settings/ai`, `org.settings.write`) —
  the same tabs with the org's own keys and models, plus the org's default and
  per-feature models. A Spend tab shows what the org's AI calls have cost in
  USD, whichever key paid: this month, last month, all time, each of the last
  30 days and this month by feature.
  Registered into the tenancy settings shell through core's
  org-settings-section registry; absent in single-tenant deployments.
- **Spend log** — every provider call (chat, transcription, decisions,
  embeddings) is recorded in `ai_usage` with its tokens and cost, attributed
  to the org (or, for a personal app, the user) the run was resolved for.
  Served to the org page by **`GET /api/ai/org/usage`** (`org.settings.write`).
- **`GET /api/ai/status`** — org-aware readiness probe (`configured`,
  `hasEnabledModel`, `featureAvailable`) for consumer client UIs.
- **`GET /api/ai/models`** — the live, tool-capable model list from every
  catalog loaded so far (cached an hour).

Core ships a throwing `#ai/server` fallback, so a consumer layer can import
`#ai/server` unconditionally and simply gate on `isAiConfigured(tx)` — the app
still builds and runs with the AI layer (or any key) absent.

## Embeddings and vector indexes

Layers that keep a vector index (context sections, helpinator libraries) embed
through this layer too:

- `embed({ tx, input })` — OpenRouter `POST /embeddings` with the embedding
  model that resolves for the org (org choice → host choice). Every vector is
  `AI_EMBED_DIMENSIONS` (1536) wide so one `vector(1536)` column fits any model.
- `isEmbeddingConfigured(tx)`, `resolveEmbeddingModel(tx)`,
  `getEmbeddingModelList()` — the readiness probe, the resolution, and the live
  `GET /embeddings/models` list.
- `chunkMarkdown()`, `vectorSql()`, `cosineDistance()` — pure helpers for
  chunking content and querying pgvector, shared through `#ai/server` (they live
  in core so they exist without this layer too).
- `registerAiFeature({ kind: 'embedding', … })` — declares that a layer builds
  an index; the **Embedding model** section appears on the AI settings pages
  only when some loaded layer has.
- `registerAiReindexer({ key, label, currentModels, run })` — lets the settings
  pages rebuild a layer's index after the embedding model changes. Both pages
  show a warning when stored chunks were built with another model than the one
  that resolves now, with a re-embed button (the org page for that org, the host
  page for every affected org).

The database needs pgvector. Migrations run `CREATE EXTENSION IF NOT EXISTS
vector` when their role may; otherwise a superuser runs it once beforehand.

## Setup

1. Add the layer to `extends:` (via `layers.ts` in a prod host, or `dev/layers.ts`).
2. Set the env:

   ```bash
   NUXT_SECRET_ENCRYPTION_KEY=<64 hex chars>   # core; encrypts stored keys
   # optional — host keys, the fallback for orgs without their own. Each can
   # instead be stored on Admin → AI; one set here wins and is read-only there.
   OPENROUTER_API_KEY=sk-or-...
   OPENAI_API_KEY=sk-...
   ANTHROPIC_API_KEY=sk-ant-...
   OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
   AI_HTTP_REFERER=https://your-app.example    # OpenRouter attribution
   AI_APP_TITLE=Your App
   ```

3. Open **Admin → AI**, add a key for a provider if none is in the env, enable
   at least one model and choose a default. Nothing
   is enabled on a fresh deployment — the code carries no model ids, so AI
   features stay off until an admin picks.

## Tinfoil (confidential inference)

Once a Tinfoil key exists (env, Admin → AI, or an org's own), Tinfoil's models
join the pickers, prefixed `tinfoil/` (e.g. `tinfoil/glm-5-3-flash`). Every Tinfoil request goes through
the SDK's `SecureClient`: the enclave's attestation is verified first and each
request body is encrypted to the attested key, so prompts, images and audio
are readable only inside the verified enclave. A failed verification refuses
the request.

Tinfoil also brings speech-to-text: features registered with
`kind: 'transcription'` pick from its transcription models and call
`transcribe()`.

```bash
TINFOIL_API_KEY=tk_...
# optional:
TINFOIL_CATALOG_URL=https://api.tinfoil.sh/api/config/models
TINFOIL_USER_CACHE_SECRET=<random>   # scopes Tinfoil's prompt cache; random per process when unset
```

## OpenAI and Anthropic

Models called on the providers' own APIs are stored as `openai-api/<id>` and
`anthropic-api/<id>`, so they never collide with OpenRouter's `openai/…` and
`anthropic/…` slugs. Their lists come from each provider's `GET /models` (which
needs a key): OpenAI ids are kept when OpenRouter describes the same model,
borrowing its prices and capabilities; Anthropic models carry their own context
window and capabilities, with prices from OpenRouter's matching entry.

Anthropic runs on the Messages API, translated to and from the
OpenAI-compatible shape the rest of the client uses: prompt caching
(`cache: true`) carries over, thinking blocks are sent back unchanged between
tool rounds, and `generate()`'s forced tool call is sent as `auto` with an
instruction, since newer Claude models reject forced `tool_choice`.
`reasoning` maps to `output_config.effort`; models that think by default get
at least 16k `max_tokens`, since thinking shares that budget.

## Whose key, whose models

Decided per provider:

| Org has its own key for the provider? | Key used | That provider's models the org may pick |
|---|---|---|
| No | the host's (env, else stored on Admin → AI) | the host-enabled ones |
| Yes | the org's key | the ones the org enabled on its page |

A feature resolves to the first usable model in: the org's choice for the
feature → the org's default → the host's choice for the feature → the host's
default. A choice that is no longer usable (key removed, model delisted) is
skipped, not deleted, and shows as unavailable in the pickers.

## Consuming it from another layer

```ts
import { isAiConfigured, generate, registerAiFeature } from '#ai/server'

// At boot (a Nitro plugin): declare your feature so it gets a model picker.
registerAiFeature({ key: 'inbox.draft', label: 'Inbox — draft replies' })

// In a handler (inside the org tx):
if (!(await isAiConfigured(tx))) throw createError({ statusCode: 503, statusMessage: 'AI is not configured' })
const { input } = await generate<{ reply: string }>({
  tx,
  feature: 'inbox.draft',
  system: [{ type: 'text', text: bigGroundingPrefix, cache: true }], // cache: prompt-cache on capable models
  messages: [{ role: 'user', content: 'Draft a reply to …' }],
  tool: {
    name: 'submit_draft',
    description: 'Submit the drafted reply',
    parameters: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] }
  }
})
```

### Images, reasoning and transcription

```ts
import { generate, transcribe, registerAiFeature } from '#ai/server'

registerAiFeature({ key: 'notes.transcribe', label: 'Notes — transcribe', kind: 'transcription' })

// Images ride as content parts; a model that can't read images is a 400.
await generate({
  tx, feature: 'notes.file', tool,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'File this receipt' },
    { type: 'image', mediaType: 'image/jpeg', data: base64 }
  ] }],
  reasoning: 'low'   // 'off' | 'low' | 'medium' | 'high'; sent only to models whose catalog says how
})

const { text } = await transcribe({ tx, feature: 'notes.transcribe', audio: bytes, mimeType: 'audio/mp4' })
```

### Decisions

Decision models answer typed questions about an input with probabilities
instead of generating text: cheap, fast classification, routing, triage and
rubric scoring. OpenRouter lists them under the `decisions` output modality;
Tinfoil's are `decision-small`, `-medium` and `-large` (text only). Both join
the pickers with a **Decision** badge; register a feature with
`kind: 'decision'` to get a picker for one.

```ts
import { decide, registerAiFeature } from '#ai/server'

registerAiFeature({ key: 'inbox.triage', label: 'Inbox — triage', kind: 'decision' })

const { answers } = await decide({
  tx,
  feature: 'inbox.triage',
  input: 'Charged three times for one $49 order, wants a refund.', // or a JSON object
  questions: {
    escalate: { type: 'predicate', instructions: 'Should a human handle this?',
      criteria: { true: 'Angry, legal or safety', false: 'Routine' } },          // criteria optional
    team: { type: 'choice', instructions: 'Which team owns this?',
      choices: [{ value: 'billing', description: 'Charges, refunds' }, { value: 'shipping' }] },
    urgency: { type: 'score', instructions: 'How urgent?', levels: ['routine', 'soon', 'critical'] }
  }
})
answers.escalate // { type: 'predicate', probability: 0.66 }
answers.team     // { type: 'choice', choice: 'billing', confidence: 0.99, probabilities: { billing: 0.99, shipping: 0.01 } }
answers.urgency  // { type: 'score', score: 0.98, confidence: 0.75, probabilities: [0.14, 0.75, 0.12] }
```

`score` is the probability-weighted level index (0 = the first level). Every
question gets an answer, or the call fails with 502. They bill input tokens
only, once per question.

## Testing against the fake

Under VITEST the client never touches the network: `complete()`, `generate()`
and `decide()` route to a primeable fake, the model list is a fixed set
(chat `test/alpha`, `test/beta`, `test/gamma`, decision `test/decider`), and
any key other than the literal `invalid` verifies. A feature with no
configured model runs on `test/alpha` (a decision feature on `test/decider`).
Unscripted, `decide()` answers yes, the first choice and the lowest level;
script answers by question name with `primeAiFake({ decisions: { … } })`.
Script the fake over `/api/_test/ai` (only served under VITEST) with the helpers
exported from this layer's `tests/helpers`:

```ts
await primeAiFake({ text: 'Here is the answer.', toolCalls: [{ name: 'load_section', input: { section_key: 'team' } }] })
// ... call your endpoint ...
const log = await getAiFakeLog()   // what the model was asked, and each tool result
await resetAiFake()
```

A streaming `complete()` gets the scripted text from the fake word by word.
Script `discardedText` to have it stream a preface before its tool calls and
then discard it, which exercises a consumer's `onTextDiscard`.

## Notes

- **Nothing model-specific lives in code.** Names, prices, context windows and
  capability flags come from OpenRouter's model list; the DB stores only the
  ids an admin or org chose. Host choices live in `core_host_settings`
  (deployment-global), org choices and the org key in `core_settings`
  (RLS-scoped per org), both under namespace `ai`.
- **Stored keys are encrypted at rest** with core's secret-crypto and never
  returned to the browser (only the last four characters). Rotating
  `NUXT_SECRET_ENCRYPTION_KEY` makes every stored key unreadable; the pages
  then ask for it to be removed and re-entered.
- **Sampling params are guarded per model.** Some models reject `temperature`;
  the client only sends it to models OpenRouter reports as accepting it.
- **Prompt caching** rides through via `cache_control` to models OpenRouter
  prices cache reads for; keep your grounding prefix byte-stable so
  caching-capable models hit it. The tool loop sends the tool definitions on
  every round (past `maxToolRounds` it adds `tool_choice: 'none'` rather than
  dropping them) because the definitions lead the cached prefix. Each round
  trip logs `[ai] <model> prompt=… cached=… cache_write=…` so hits can be
  checked in the server log.
