# Technology: OpenAI GPT-5.6 via the Responses API

## What is it?

The Responses API is OpenAI's current server-side interface for generating model
output. It replaces the older Chat Completions shape — instead of assembling a
`messages` array where the system prompt is just the first element, a request has
two distinct fields: `instructions` for the developer's own instructions, and
`input` for the end user's content. Built-in tools (web search, file search, code
interpreter) and multi-turn state are first-class parameters rather than things
you wire up yourself. GPT-5.6 is the current model family on top of it, split
into variants that trade cost against reasoning depth — this project defaults to
`gpt-5.6-terra`, which is a good fit for short, structured generation where I
want solid reasoning but do not need the highest-cost coding model.

The practical difference for this project is the field split. A single call looks
like `openai.responses.create({ model, instructions, input })`, and
`response.output_text` gives the text back. That separation is not just tidier —
it is the boundary I rely on for prompt security.

## How could Stunning use it?

This app *is* the smallest version of the use case: turn a short product
description plus a set of selected capabilities into a structured plan. The same
call shape scales up in a few directions that matter for a product like Stunning.
Prompt-driven planning is the obvious one — the `instructions`/`input` split maps
exactly onto "our product rules" versus "what this user typed", which is what
lets me safely put user text near a system prompt at all. Beyond planning, the
built-in tool calling is what turns a planner into a builder: the same request
can be given tools that scaffold a project, write files, or query real data,
without the app hand-rolling an agent loop. And because the API supports
structured output, the free-text plan this app renders today could become typed
JSON that drives real UI — sections, feature lists, and integration mappings as
data instead of text a human has to re-read.

## What are its limitations?

Cost is per token and rises with reasoning depth, so a feature like this has a
unit economic attached to every click — which is exactly why this app's biggest
production risk is unauthenticated spend rather than anything about the model.
Rate limits and spend caps are set per account and per model, and they are an
external dependency I do not control: I hit real quota exhaustion while testing
this project, on both vendors. Latency is the next constraint — a reasoning model
takes seconds, not milliseconds, which is why this app has a hard time budget and
a skeleton state rather than a spinner and hope. Output is nondeterministic, so
two identical requests give different plans, and prompt behaviour shifts when
models are updated or retired; a prompt tuned today is not guaranteed to behave
identically in six months, which argues for pinning model versions and keeping
the prompt in one testable place. Finally, the fallback I added is itself a
limitation: it buys availability, but it doubles the vendor surface and means the
same request can be served by a different model with different characteristics.

## Would I use it today? Why or why not?

Yes — for this use case, as the primary provider, with server-side controls
around it. It is the right tool when the job is "turn unstructured text into
structured output" and the value comes from reasoning quality rather than raw
throughput. I would not use it without the things this project already does:
credentials server-side only, an allowlist between user input and the system
prompt, independent request validation, a bounded timeout, and normalised errors
so provider problems never reach the browser raw.

What I would add before it carried real traffic is the list in DECISIONS.md —
authentication, per-account quotas, and hard spend caps at the provider — because
the model is not the risk, the unmetered access to it is. Where I would *not*
reach for it is anything latency-critical or extremely high-volume with a
mechanical transformation at its core; there a smaller, cheaper, faster model, or
plain code, wins. The fallback to Gemini is worth it here specifically because
availability matters more than perfect output consistency for this feature — for
a feature where consistency mattered more, I would drop the fallback and let it
fail cleanly instead.
