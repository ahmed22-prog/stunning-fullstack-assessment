# Technology: OpenAI GPT-5.6 via the Responses API

I picked this because it's what this project actually runs on, so I can talk
about it from experience rather than from documentation.

## What is it?

The Responses API is OpenAI's current interface for generating model output. The
older Chat Completions style put everything into one `messages` array, where the
system prompt was just the first item in the list. The Responses API splits that
into two separate fields: `instructions` for the developer's rules and `input`
for the user's content. Tools like web search and file search, and multi-turn
state, are proper parameters instead of things you wire up by hand.

GPT-5.6 is the current model family. The variants trade cost against how much the
model reasons before answering. I default to `gpt-5.6-terra`, which is a good fit
for short structured output where I want decent reasoning but don't need the most
expensive model.

One call looks like this:

```ts
const response = await openai.responses.create({
  model: "gpt-5.6-terra",
  instructions: systemPrompt,  // my rules
  input: userPrompt,           // what the user typed
});

const text = response.output_text;
```

The field split is the part I care about most. It isn't just tidier, it's the
boundary this whole app's prompt security is built on. My instructions and
untrusted user text never share a channel.

## How could Stunning use it?

This app is the smallest version of the use case: take a short description and
turn it into a structured plan. It scales in a few directions that matter for a
product like Stunning.

**Prompt-driven planning** is what's here already. The `instructions` / `input`
split maps directly onto "our product's rules" versus "what this user typed",
which is what makes it safe to put user text anywhere near a system prompt.

**Tool calling** is what turns a planner into a builder. The same call can be
given tools that scaffold a project, write files, or look up real data, without
the app hand-rolling an agent loop.

**Structured output** means the plan could come back as typed JSON instead of
text. Right now I render a paragraph the user has to read. Instead I could get
back something like:

```json
{ "features": ["plan selection", "monthly billing"], "integrations": ["Stripe"] }
```

and render each item as its own card, or use it to drive real UI.

## What are its limitations?

**Cost.** You pay per token, so every click has a price. That's exactly why the
biggest production risk in DECISIONS.md is spend, not the model.

**Rate limits and quotas are outside my control.** They're set per account and
per model. I hit real quota exhaustion on both providers while building this,
which is also why the error handling separates "you've hit a limit" from "the
service is down".

**Latency is in seconds, not milliseconds.** A reasoning model takes a while.
That's why this app has a hard time budget and a skeleton state instead of a
spinner and hope.

**Output is nondeterministic.** Two identical requests give two different plans.
The shape stays the same but the wording doesn't, so anything downstream has to
tolerate that.

**Model behaviour moves.** Models get updated and retired, and a prompt tuned
today isn't guaranteed to behave the same in six months. I actually ran into a
retired model during this project. It argues for pinning model versions and
keeping the prompt in one place you can test.

**The fallback is its own limitation.** It buys availability, but it doubles the
vendor surface and means the same request can be served by a different model with
different output characteristics.

## Would I use it today?

Yes, as the primary provider, for this kind of job, with server-side controls
around it. It's the right tool when the work is turning unstructured text into
structured output and the value comes from reasoning quality rather than raw
speed or volume.

I wouldn't use it without the things this project already has: keys server-side
only, an allowlist between user input and the prompt, validation that runs
independently on the server, a bounded timeout, and normalised errors so provider
problems never reach the browser raw.

Before it carried real traffic I'd add what's listed in DECISIONS.md:
authentication, per-account quotas, and hard spend caps at the provider. The
model isn't the risk. Unmetered access to it is.

Where I wouldn't reach for it is anything latency-critical, or very high volume
where the actual work is a mechanical transformation. There a smaller and cheaper
model, or just plain code, wins easily.

The Gemini fallback is worth it here because for this feature availability
matters more than perfectly consistent output. If consistency mattered more, I'd
drop the fallback and let it fail cleanly instead.
