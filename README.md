# Stunning — Build Plan Generator

Describe something you want to build, optionally pick which services it should
use, and an AI model writes you a build plan: a summary, core features, an
integration plan, and a first milestone.

The five integrations (Stripe, Shopify, Gmail, Slack, Google Sheets) are context
only. Picking them changes the instructions sent to the model. Nothing connects
to a real third-party API.

## Stack

- Next.js 16 (App Router) + React 19
- TypeScript
- Tailwind CSS v4
- `openai` for the primary provider, `@google/genai` for the fallback (both server-side)

## How the two providers work

OpenAI is always tried first. Gemini only runs if the OpenAI call fails because
the service wasn't available: a rate limit, a 5xx, a timeout, or a network error.

It does **not** fall back when the key is missing or rejected, when the model
name is wrong, or when content was blocked for safety. Those are either my bug
or a decision I shouldn't work around, and hiding them behind a second provider
means nobody finds out.

Gemini is optional. Without a Gemini key the app still works, an OpenAI outage
just shows an error instead.

## What you need

- Node.js 20.9+ (Next.js 16 needs it; I used 22.x)
- npm
- An OpenAI API key: https://platform.openai.com/api-keys
- Optionally a Gemini key for the fallback: https://aistudio.google.com/apikey

Both are paid APIs. Rate limits, per-day quotas and spend caps depend on your
account and plan and they change over time, and some keys need billing switched
on separately. If you get a rate-limit error, check the provider's console
before assuming the app is broken.

## Setup

```bash
npm install
cp .env.example .env.local
```

Then fill in `.env.local`:

```env
# Primary provider
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra

# Fallback provider (optional)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
```

Both model variables are optional and fall back to the values above. Nothing is
prefixed with `NEXT_PUBLIC_`, so no key ever reaches the browser. `.env.local` is
git-ignored.

## Run it

```bash
npm run dev
```

Then open http://localhost:3000.

## Checks

```bash
npm run lint
npm run typecheck
npm run build
```

These work on a fresh clone in any order. None of them needs you to have run the
dev server first.

## Request flow

```text
browser (app/page.tsx)
  POST /api/generate  { prompt, integrations: ["stripe", "gmail"] }
    validate the prompt (required, trimmed, max 2000 chars)
    resolve the integration ids against the allowlist (lib/integrations.ts)
    build one system prompt from the resolved names (lib/prompt.ts)
    lib/ai.ts: OpenAI first, Gemini only on an availability failure
    turn the result or the error into JSON
  { text } or { error, code }
  rendered as plain text
```

| Path                        | What it does                                          |
| --------------------------- | ----------------------------------------------------- |
| `app/page.tsx`              | The whole UI, state, client validation, request        |
| `app/api/generate/route.ts` | Parsing, server validation, mapping errors to HTTP     |
| `lib/ai.ts`                 | Both provider calls and the fallback rule              |
| `lib/integrations.ts`       | The id to display-name allowlist                       |
| `lib/prompt.ts`             | Builds the system prompt (server only)                 |
| `lib/validation.ts`         | The prompt length limit, shared by client and server   |
| `lib/rate-limit.ts`         | In-memory per-IP limiter                               |

## Notes on security

- **Keys stay on the server.** Both are read from `process.env` in server code.
  There's no `NEXT_PUBLIC_*` variable and the browser never calls a provider.
- **The server validates on its own.** The client disables bad submissions, and
  the route checks everything again: valid JSON, body is an object, prompt is a
  non-empty string within the limit, integrations is an array of strings. No
  provider is called until that passes.
- **Integration ids go through an allowlist.** The browser sends ids like
  `stripe`. The server looks each one up and only the name it owns ends up in the
  prompt. An id that isn't on the list returns a 400, so a random string can
  never reach the model.
- **Instructions and user text stay separate,** the same way for both providers.
  My instructions go in OpenAI's `instructions` and Gemini's `systemInstruction`.
  The user's text goes in OpenAI's `input` and Gemini's `contents`.
- **Output is rendered as text,** with `white-space: pre-wrap`. No
  `dangerouslySetInnerHTML` and no Markdown renderer.
- **Errors don't leak.** Provider errors are logged as a short summary and the
  browser gets one of a fixed set of messages I wrote. No stack traces, no SDK
  objects, no env values.
