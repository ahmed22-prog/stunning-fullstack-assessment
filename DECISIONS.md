# Decisions

The framing: this ships tomorrow and I had 60 minutes to improve it.

## What did I improve?

### Keeping my instructions and the user's text apart

My instructions go on the instruction channel (`instructions` for OpenAI,
`systemInstruction` for Gemini). The user's text goes on the content channel
(`input` / `contents`).

`lib/prompt.ts` only ever receives integration names that already passed the
allowlist, so there's no code path where user input ends up in the instructions.
There's one `buildSystemPrompt()` and both providers get the exact same string,
so they can't drift apart.

The prompt also tells the model to treat the user message as a product
description and ignore instructions inside it. That's a second layer, not the
main one. The main one is the channel split.

### The integration allowlist, and rejecting unknown ids

`lib/integrations.ts` holds the `id -> display name` map. The route resolves every
id the client sent against it. Duplicates collapse, the names come back in the
file's order rather than the client's, and an unknown id fails the request with a
400.

I went with rejecting instead of quietly dropping. A real client can only send
ids it got from that same list, so an unknown id means either a bug or someone
poking at the endpoint. Dropping it silently would produce a plan missing an
integration the user thinks they selected, which is a wrong answer that looks
right. Either way the unknown string never reaches the prompt, but rejecting also
tells the user something happened.

### OpenAI primary, Gemini fallback, and a narrow rule

`lib/ai.ts` tries OpenAI, then falls back to Gemini only for `rate_limited`,
`unavailable` and `timeout`. It does not fall back for:

- **Configuration problems** (missing key, 401, 403, 404 on a retired model).
  If my key is wrong and I quietly switch providers, the site looks healthy,
  nobody fixes the key, and I find out weeks later from the bill.
- **Safety blocks.** Sending the same text to a second provider is just looking
  for a different answer to a question that was already answered.
- **Empty responses.** Not an availability problem, and paying a second provider
  for an unclear result isn't worth it.
- **Unknown errors.** If I can't name the failure I can't call it temporary.

Validation runs before either provider, so a bad request never costs money.

**The trade-off:** this buys availability and it costs me things. Two vendors
means two sets of credentials, two quotas, two status pages, and a bit more code.
It also means the same request can be answered by a different model, so output
style varies. And a fallback attempt adds latency on top of a failed first
attempt. I think a slightly different plan beats no plan, but it isn't free.

### No provider abstraction

Two functions and one chooser in a single file. No interface, no adapter, no
registry, no DI. There are two providers called from one place, and the whole
policy is one array (`FALLBACK_ELIGIBLE`) you can read in a few seconds. An
abstraction here would hide the one thing someone reading this needs to see.

### Errors sorted by cause, not by status code

Provider errors get normalised into a small `FailureKind` union in `lib/ai.ts`,
and the route turns that into HTTP:

- 401/403/404 -> configuration error, 500, "contact the site owner"
- 429 -> `rate_limited`, **429**, not a generic 503
- 408 and 5xx -> `service_unavailable`, 503
- timeout -> 504
- safety block -> 422
- empty answer -> 502

An earlier version folded 429 into "temporarily unavailable, try again in a
moment". That's misleading when the real cause is a quota that's finished for the
day, so it got its own branch.

### Retries and fallback are not the same thing

OpenAI runs with `maxRetries: 0`. There's a whole second provider behind it, so
retrying the same one only delays getting there. The SDK's timeout is also per
attempt, so retries would push past the total budget.

Gemini keeps two attempts for real transient errors, but I took 429 out of its
retryable status codes. The SDK retries it by default, which meant a finished
daily quota got retried three times before failing.

**The trade-off:** a single blip on OpenAI now switches models instead of just
trying again, so the user may get a plan written in a slightly different style.

### Retry is only offered when it can work

The client reads the error `code` and hides the "Try again" button for
`rate_limited`, `not_configured`, `blocked` and `invalid_request`. Clicking a
button doesn't refill a quota or fix a server config.

Application-level 429s send a `Retry-After` header, and if a provider gives us
its own `retry-after` we pass that through. If it doesn't, we don't make one up.

### One time budget for the whole request

50s total: 30s for OpenAI, the rest for Gemini, and the fallback is skipped if
under 10s is left because it couldn't finish anyway. Gemini's `abortSignal`
covers its whole call including its retries.

The previous single-provider version used 30s and the all-integrations path went
past it under real load. The point of splitting the budget is that adding a
fallback shouldn't turn into 30s + 30s of waiting.

### Validation on both sides, separately

The client keeps a live character count, disables the button on empty,
whitespace-only or over-limit input, and sets `aria-invalid`. The route works it
all out again: valid JSON, body is an object and not an array, prompt is a string
that isn't empty after trimming and is at most 2000 characters, integrations (if
present) is an array of strings.

### Wording that matches reality

The prompt says integrations are "available for this build context", not
"connected". They're dummy context, the footer on the page says so, and the
prompt shouldn't contradict the UI. With nothing selected it says so directly and
asks for built-in functionality instead of naming third-party products the user
can't even pick.

### The four request states

`idle | loading | success | error` drive the page. Starting a request clears the
old error and result, shows a skeleton, and disables the button. A guard plus the
`disabled` attribute stops double submits. Every state has a designed panel,
including the empty one.

### Prompt code stays out of the browser bundle

The page and the route both need the 2000-character limit, so it lives in
`lib/validation.ts` instead of next to `buildSystemPrompt`. That way the client
never imports `lib/prompt.ts` or `lib/ai.ts` at all, and the prompt text stays
server-side because of the file layout rather than because I trust tree-shaking.
I checked the built client chunks for a phrase from the system prompt: it isn't
there.

### The rate limiter

10 requests per IP per rolling minute, returning a 429 and a retry hint. It runs
before the body is parsed, so malformed requests use up budget too. That's
deliberate: it exists to limit abuse of an endpoint that spends money, and
someone sending ten broken requests a minute isn't the case I want to optimise
for.

### Accessibility and polish fixes

`--ink-subtle` was at 3.7:1 against raised surfaces, which fails AA for small
text. It's now 5.3:1 or better everywhere and still lighter than `--ink-muted`,
so the hierarchy didn't change. The global focus rule was also overriding each
element's `border-radius`, so focused cards jumped from 12px to 4px. Fixed. Added
`prefers-reduced-motion` for the spinner and skeleton, and replaced the default
Next.js favicon.

## What did I leave out, and why?

**Authentication.** The biggest thing a real deployment needs and the most
expensive to build: sessions, storage, a sign-in screen, and the UX around it. It
would have used the entire budget and shown the reviewer nothing they asked for.
It's the top production risk below instead.

**A database / history.** Needs a schema and list and detail screens. The
assessment is about one request and one response.

**Distributed rate limiting.** The real fix is Redis or a platform limiter, which
is a dependency and an ops story. I shipped the honest in-memory version and
wrote down exactly why it isn't enough.

**Streaming.** Nicer to watch, but it changes the transport, the error handling,
and the empty-response check. With a fallback it also means deciding what to do
when the first provider dies after you've already sent bytes. The skeleton gets
most of the perceived speed for far less complexity, and the answer is capped at
about 400 words anyway.

**Tests.** I put the time into the validation, error and fallback paths and
checked them by hand against a local stub of both providers. The parts I'd test
first (`resolveIntegrationNames`, `parseBody`, `buildSystemPrompt`, the fallback
rule) are already pure functions, so adding tests later is cheap. That shape is
on purpose.

**Structured logging.** `console` with short, greppable context
(`primary=openai fallback=gemini fallback_reason=...`) is enough here. Structured
logs and tracing need somewhere to go before they're worth anything.

**Telling the browser which provider answered.** The response is just `{ text }`.
Which provider served it is an operations detail, and putting it in the UI would
invite explaining infrastructure nobody asked about.

**Real integrations, a theme toggle, i18n, analytics, extra routes, a state
library, service or repository layers, DI.** Out of scope. `useState` in one
component is the right tool for the state this page holds.

## What's the biggest production risk?

**Unlimited spend through an endpoint anyone can call, now across two vendors
instead of one.**

`POST /api/generate` takes any request from anyone and turns it into a paid call
with up to 4096 output tokens. Nothing ties a request to a person. A small script,
or one link posted publicly, becomes an open-ended bill, and I wouldn't find out
until the invoice arrived.

The fallback makes this worse, not better, and that's the honest cost of the
design. An OpenAI rate limit is the signal that would normally slow an attacker
down, and instead of surfacing it I go spend money at a second provider.

The limiter in `lib/rate-limit.ts` is real but it doesn't solve this:

- It resets on every restart and deploy, because the state is a module-level Map.
- It's per instance. On serverless or multiple instances the real limit is
  `10 x number of instances`, and that number goes up exactly when traffic does.
- It keys on `x-forwarded-for`, which the client controls. Behind a proxy that
  rewrites that header it means something. Without one, rotating the header
  defeats it.
- It counts requests, not cost, and it isn't tied to an identity, so a heavy
  legitimate user and an attacker look the same.

It's a speed bump for double-clicks and casual scraping. That's all.

What I'd do, in order:

1. **Authentication**, so every request belongs to an account. Everything else
   depends on it.
2. **A per-account quota** in shared storage. That's the limit users understand
   and the one that maps to money.
3. **Distributed rate limiting** (Redis or the platform's edge limiter) so the
   ceiling is global instead of per instance.
4. **Hard spend caps at both providers** with alerts, so the worst case is a
   degraded service and not an open bill. Plus a switch to turn the fallback off,
   so a spend problem can't just move to the other vendor.
5. **Monitoring on requests, tokens, cost per account, and how often the fallback
   fires.** A rising fallback rate is both a cost signal and an early warning
   that the primary is unhealthy. Right now nobody would notice either one until
   billing did.
