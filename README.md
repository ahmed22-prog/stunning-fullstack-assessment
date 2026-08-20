# Stunning — Build Plan Generator

## Overview

A single-page app where you describe something you want to build, optionally
select which integrations it should use, and get an AI-generated implementation
plan: a summary, core features, an integration plan, and a first milestone.

The five integrations (Stripe, Shopify, Gmail, Slack, Google Sheets) are
**context only** — selecting them changes the instructions sent to the model.
Nothing connects to a real third-party API.

## Stack

- Next.js 16 (App Router) + React 19
- TypeScript
- Tailwind CSS v4
- `openai` — **primary** provider, server-side only
- `@google/genai` — **fallback** provider, server-side only

## Providers

OpenAI is always attempted first. Gemini runs only when the OpenAI attempt fails
for an *operational availability* reason — rate limit, 5xx, timeout, or a network
failure. It is never used to paper over a configuration problem (missing key,
401, 403, retired model) or a safety block, because hiding those behind a working
second provider would leave a broken deployment looking healthy.

Gemini is optional. Without `GEMINI_API_KEY` the app still works; an OpenAI
outage simply surfaces as an error instead of falling back.

## Prerequisites

- Node.js 20.9+ (Next.js 16 requirement; developed on 22.x)
- npm
- An OpenAI API key — <https://platform.openai.com/api-keys>
- Optionally a Gemini API key for the fallback — <https://aistudio.google.com/apikey>

Both providers are paid, metered services. Rate limits, request/day quotas, and
spend caps vary by account, model, and plan, and they change over time — an API
key may also require billing to be enabled separately. If you see a rate-limit
error, check the provider's console rather than assuming the app is broken.

## Installation

```bash
npm install
```

## Environment setup

Copy the template and fill in your keys:

```bash
cp .env.example .env.local
```

```env
# Primary provider — OpenAI. Required.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra

# Fallback provider — Gemini. Optional.
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
```

Both `*_MODEL` variables are optional and fall back to the defaults above.
No variable is prefixed with `NEXT_PUBLIC_`, so none is ever sent to the browser.
`.env.local` is git-ignored.

## Running locally

```bash
npm run dev
```

Open <http://localhost:3000>.

## Verification

```bash
npm run lint
npm run typecheck
npm run build
```

All three work on a fresh clone, in any order — none of them depends on a
previous dev-server run.

## How it works

```text
Browser (app/page.tsx)
  → POST /api/generate  { prompt, integrations: string[] }
  → validate prompt (required, trimmed, <= 2000 chars)
  → map integration ids against the server-side allowlist (lib/integrations.ts)
  → build one system prompt from trusted integration names (lib/prompt.ts)
  → lib/ai.ts: OpenAI first — trusted prompt as `instructions`, user text as `input`
        └ on an operational failure only → Gemini with the remaining time budget
  → normalise the response and any errors
  → JSON back to the browser  { text } | { error, code }
  → rendered as plain text
```

Files:

| Path                        | Responsibility                                              |
| --------------------------- | ----------------------------------------------------------- |
| `app/page.tsx`              | All UI, state, client-side validation, request lifecycle     |
| `app/api/generate/route.ts` | Parsing, server validation, HTTP error mapping               |
| `lib/ai.ts`                 | OpenAI primary, Gemini fallback, provider error normalisation |
| `lib/integrations.ts`       | The trusted id → display-name allowlist                      |
| `lib/prompt.ts`             | System-prompt construction (server-only, one copy)           |
| `lib/validation.ts`         | The prompt length limit, shared by client and server         |
| `lib/rate-limit.ts`         | In-memory per-IP request limiter                             |

## Security notes

- **Server-only credentials.** Both keys are read from `process.env` inside
  server code. There is no `NEXT_PUBLIC_*` variable and the browser never talks
  to a provider directly.
- **Independent server-side validation.** The client disables invalid
  submissions, and the route re-checks everything: JSON parses, body is an
  object, `prompt` is a non-empty trimmed string within the limit,
  `integrations` is an array of strings. No provider is called until it passes.
- **Integration allowlisting.** The client sends ids. The server resolves each
  id against `INTEGRATIONS` and only ever interpolates the display name it owns.
  An unrecognised id fails the request with a `400`, so an arbitrary string can
  never reach the prompt.
- **Prompt boundary, identically for both providers.** Trusted, server-generated
  instructions go in OpenAI's `instructions` and Gemini's `systemInstruction`.
  The user's raw text goes in OpenAI's `input` and Gemini's `contents`.
- **Safe output rendering.** The response is rendered as a text node with
  `white-space: pre-wrap`. No `dangerouslySetInnerHTML`, no Markdown renderer.
- **No leaked internals.** Provider errors are logged server-side as a compact
  summary and replaced with fixed, user-safe messages — no stack traces, SDK
  objects, or env values.
