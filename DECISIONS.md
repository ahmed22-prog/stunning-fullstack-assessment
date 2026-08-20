# Decisions

Framing: **this ships to production tomorrow and I had 60 minutes to improve it.**

## What did I improve?

**Prompt-security boundary, identical for both providers.** Trusted,
server-generated instructions go on the instruction channel (`instructions` for
OpenAI, `systemInstruction` for Gemini); the user's raw text goes on the content
channel (`input` / `contents`). `lib/prompt.ts` only ever receives
already-allowlisted integration names, so no code path interpolates user input
into system instructions. There is exactly one `buildSystemPrompt()` and both
providers receive its output byte-for-byte, so their behaviour cannot drift.

**Integration allowlist with an explicit rejection policy.**
`lib/integrations.ts` is the single source of truth for `id → display name`. The
route resolves every client-supplied id against it. Duplicates collapse; resolved
names come back in the file's canonical order, not the client's; and an unknown
id **fails the request with a 400** rather than being silently dropped.

I chose reject over silent-exclude deliberately. A legitimate client can only
send ids it received from the same allowlist, so an unknown id means a bug or a
probe. Silently dropping it would generate a plan that omits an integration the
user believes they selected — a wrong answer presented as a correct one. Either
policy keeps unknown strings out of the prompt; only rejection also keeps the
user informed.

**OpenAI primary, Gemini fallback — for availability only.** `lib/ai.ts` tries
OpenAI, and falls back to Gemini **only** for `rate_limited`, `unavailable`, and
`timeout`. It deliberately does not fall back on:

- **configuration failures** (missing key, 401, 403, 404 retired model) — a
  fallback that masks a broken deployment is worse than an error, because the
  deployment stays broken and nobody finds out;
- **safety blocks** — re-sending blocked content to a second provider is
  shopping for a different verdict on a decision that was already made;
- **empty responses** — not an availability problem, and paying a second
  provider for an ambiguous result is not worth the cost;
- **unknown errors** — if I cannot name the failure, I cannot claim it is
  transient.

Validation runs before either provider, so a bad request never reaches one.

**No provider framework.** Two named functions and a chooser, in one file. No
interface, no adapter, no registry, no DI. There are two providers, called from
one place, and the fallback rule is a single array (`FALLBACK_ELIGIBLE`) that can
be read in three seconds. An abstraction here would hide the one thing a reader
actually needs to understand.

**Error handling split by cause, not by status code.** Provider errors are
normalised into a small `FailureKind` union in `lib/ai.ts`, and the route maps
that to HTTP. Concretely: 401/403/404 → configuration (500, "contact the site
owner"); 429 → `rate_limited` (**429**, not a generic 503); 408/5xx → temporary
(503); timeout → 504; safety → 422; empty → 502. A previous version folded 429
into "temporarily unavailable, try again in a moment", which is actively
misleading when the real cause is an exhausted quota.

**Retries and fallback are different mechanisms.** OpenAI runs with
`maxRetries: 0` — a whole second provider stands behind it, so retrying the same
one only delays reaching the fallback. Gemini keeps two bounded attempts for
genuine transients but **429 is removed from its retryable status list**; the
SDK retries it by default, which meant an exhausted daily quota was retried three
times before failing. The trade-off: a single transient blip on OpenAI now
switches models rather than retrying, so output characteristics can change
between requests. I think a slightly different plan beats no plan.

**Retry is offered only when it can work.** The client reads the error `code` and
hides "Try again" for `rate_limited`, `not_configured`, `blocked`, and
`invalid_request` — clicking a button does not clear an exhausted quota or fix a
server misconfiguration. Application-level 429s carry a `Retry-After` header, and
a provider's own `retry-after` is passed through when it sends one. I do not
invent a delay when the provider does not give one.

**One bounded time budget for the whole request.** 50s total: OpenAI gets 30s,
and Gemini gets whatever remains (skipped entirely below 10s, since starting a
call that cannot finish only adds waiting). Gemini's `abortSignal` bounds its
whole call including retries. The previous single-provider version used 30s and
the all-integrations path exceeded it under real load; the point of the split is
that adding a fallback must not turn into 30s + 30s of user waiting.

**Validation on both sides, independently.** The client tracks a live character
count, disables the CTA on empty/whitespace-only/over-limit input, and marks the
textarea `aria-invalid`. The route re-derives all of it — JSON parses, body is a
non-array object, `prompt` is a string that is non-empty after trimming and at
most 2000 characters, `integrations` (if present) is an array of strings.

**Accurate integration wording.** The system prompt says integrations are
"available for this build context", not "connected". They are dummy context, the
page footer says so, and the prompt should not contradict the UI. With zero
selected, the prompt now says so explicitly and asks for built-in application
functionality instead of naming third-party products the user cannot select.

**Explicit four-state request UX.** `idle | loading | success | error` drives the
page. Starting a request clears the previous error and result, swaps in a
skeleton, and disables the CTA; a guard plus the `disabled` attribute prevents
double submission. Every state has a designed panel, including the empty state.

**Server-only prompt code kept out of the client bundle.** The page and the route
both need the 2000-character limit, so it lives in `lib/validation.ts` rather
than alongside `buildSystemPrompt`. The client therefore never imports
`lib/prompt.ts` or `lib/ai.ts`, and the prompt text stays server-side by
construction rather than by trusting tree-shaking. Verified by grepping the
production client chunks for a distinctive phrase from the system prompt.

**In-memory per-IP rate limiter.** 10 requests per IP per rolling minute, with a
`429` and a retry hint. It runs *before* body parsing, so malformed requests also
consume budget — deliberate, since the limiter exists to bound abuse of an
endpoint that spends money, and a client sending ten malformed bodies is not the
case worth optimising for. See the risk section for why this is a speed bump.

**Accessibility and polish fixes.** `--ink-subtle` was 3.7:1 against raised
surfaces; it is now 5.3:1 or better everywhere, still below `--ink-muted` so the
hierarchy is unchanged. The global focus rule no longer overrides each element's
`border-radius` (focused cards were snapping from 12px to 4px). Added
`prefers-reduced-motion` handling for the spinner and skeleton, and replaced the
default Create-Next-App favicon.

**Safe output rendering.** The response is a React text node with
`whitespace-pre-wrap` and `overflow-wrap: anywhere`. No `dangerouslySetInnerHTML`,
no Markdown renderer — the system prompt asks for plain text, which `pre-wrap`
renders well.

## What did I intentionally leave out, and why?

**Authentication.** The single biggest thing a real deployment needs, and the
most time-expensive: sessions, storage, a sign-in surface, and the UX around it.
Called out below as the top production risk instead.

**Persistence / history.** Needs a database, a schema, and list/detail UI. The
assessment is about one request/response flow.

**Distributed rate limiting.** The correct fix (Redis or a platform limiter) is a
dependency and an ops story. I shipped the honest in-memory version and
documented precisely why it is insufficient.

**Streaming.** Genuinely nicer for perceived latency, but it changes the
transport, the error model, the empty-response check — and with a fallback it
would also mean deciding what to do after bytes have already been sent. A
skeleton buys most of the perceived-speed benefit for a fraction of the cost.

**Automated tests.** With the time available I put it into the validation, error,
and fallback paths themselves and verified them by hand against a local stub of
both providers. The parts I would test first (`resolveIntegrationNames`,
`parseBody`, `buildSystemPrompt`, the fallback-eligibility rule) are already pure
functions, so tests are cheap to add later — that shape is deliberate.

**Observability.** `console` with compact, greppable context
(`primary=openai fallback=gemini fallback_reason=...`) is the right amount here.
Structured logging and tracing need a destination to be worth anything.

**Provider identity in the response.** The browser gets `{ text }` and nothing
else. Which provider served a request is an operational detail; surfacing it
would invite the UI to explain infrastructure the user did not ask about.

**Real integrations, dark-mode toggle, i18n, analytics, multi-page routing,
state-management library, service/repository layers, DI.** Out of scope. Local
`useState` in one component is the correct tool for the state this page holds.

## What is the biggest production risk?

**Uncontrolled paid-AI spend through an unauthenticated public endpoint — now
across two vendors instead of one.**

`POST /api/generate` accepts any request from anyone and turns it into a billed
OpenAI call with up to 4096 output tokens. Nothing ties a request to a person or
a quota. A trivial script — or one link on social media — converts directly into
an unbounded bill, and the failure is silent until the invoice arrives.

The fallback makes this *worse*, not better, and that is the honest trade-off of
the design: an OpenAI rate limit is the signal that would otherwise slow an
attacker down, and instead of surfacing it we spend money at a second vendor. Two
providers also means two sets of credentials, two quotas, two status pages, and
two ways for output quality to differ between otherwise identical requests.

The in-memory limiter in `lib/rate-limit.ts` genuinely exists, and genuinely does
not solve this:

- **It resets on every restart and deploy.** State lives in a module-level `Map`.
- **It is per-instance.** On any serverless or multi-instance deployment the
  effective limit is `10 × (live instances)` and grows exactly when traffic
  spikes.
- **It keys on `x-forwarded-for`, which the client controls.** Behind a trusted
  proxy that rewrites the header this is meaningful; without one, rotating the
  header defeats it.
- **It limits requests, not cost**, and is **not tied to an identity**, so a
  heavy legitimate user and an attacker are indistinguishable.

Treat it as a speed bump against double-clicks and casual scraping.

What I would actually do, in priority order:

1. **Authentication**, so every request maps to an account. Everything depends
   on this.
2. **A per-account quota** in shared storage — the limit users understand and the
   one that maps to cost.
3. **Distributed rate limiting** (Redis or the platform's edge limiter) so the
   ceiling is global rather than per-instance.
4. **Hard spend caps at both providers**, plus alerting, so the worst case is a
   degraded service rather than an open-ended bill — and a kill switch for the
   fallback specifically, so a spend incident cannot simply migrate vendors.
5. **Monitoring on requests, tokens, cost per account, and fallback rate.** A
   rising fallback rate is both a cost signal and an early warning that the
   primary is unhealthy; right now nobody would notice either until billing did.
