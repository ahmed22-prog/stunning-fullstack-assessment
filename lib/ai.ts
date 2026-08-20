/**
 * Plan generation: OpenAI primary, Gemini fallback.
 *
 * This is deliberately two functions and a chooser, not a provider framework.
 * Both providers receive the *same* system prompt from lib/prompt.ts, and both
 * keep the same boundary: trusted server-built instructions go on the provider's
 * instruction channel, the user's raw text goes on the content channel.
 *
 * Fallback exists to survive a provider being unavailable. It must never hide a
 * broken configuration or a safety decision — see FALLBACK_ELIGIBLE below.
 */

import { ApiError as GeminiApiError, GoogleGenAI } from "@google/genai";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError as OpenAIApiError,
  APIUserAbortError,
  OpenAI,
} from "openai";

const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 4096;

/**
 * One wall-clock ceiling for the whole request, split so that a slow primary can
 * never turn into "30s of OpenAI + 30s of Gemini". The primary gets a fixed
 * slice; the fallback gets whatever is left of the total.
 */
const TOTAL_BUDGET_MS = 50_000;
const PRIMARY_BUDGET_MS = 30_000;
/** Below this there is no point starting a fallback — it would only add waiting. */
const MIN_FALLBACK_BUDGET_MS = 10_000;

export type ProviderName = "openai" | "gemini";

/** Why an attempt failed, normalised so the route never inspects an SDK error. */
export type FailureKind =
  | "not_configured"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "blocked"
  | "empty_response"
  | "unknown";

/**
 * The whole fallback policy, in one line.
 *
 * Included: the provider is up but cannot serve us right now.
 * Excluded on purpose:
 *   not_configured — a bad key or a retired model is our bug; falling back would
 *                    hide a broken deployment behind a working one.
 *   blocked        — re-sending blocked content to a second provider is shopping
 *                    for a safety verdict we already got.
 *   empty_response — not an availability failure, and paying a second provider
 *                    for an ambiguous result is not worth the cost.
 *   unknown        — if we cannot name the failure we cannot call it transient.
 */
const FALLBACK_ELIGIBLE: readonly FailureKind[] = [
  "rate_limited",
  "unavailable",
  "timeout",
];

type Attempt =
  | { ok: true; text: string }
  | { ok: false; kind: FailureKind; retryAfterSeconds?: number };

export type GenerationResult =
  | { ok: true; text: string; provider: ProviderName }
  | { ok: false; kind: FailureKind; retryAfterSeconds?: number };

export type GenerationInput = {
  /** Trusted, server-built. Never contains user text. */
  systemPrompt: string;
  /** The user's raw text. Never reaches an instruction channel. */
  userPrompt: string;
};

export async function generatePlan(
  input: GenerationInput,
): Promise<GenerationResult> {
  const startedAt = Date.now();

  const primary = await callOpenAI(input, PRIMARY_BUDGET_MS);
  if (primary.ok) {
    return { ok: true, text: primary.text, provider: "openai" };
  }

  if (!FALLBACK_ELIGIBLE.includes(primary.kind)) {
    return primary;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("primary=openai failed and no fallback is configured.", {
      primary_failure: primary.kind,
    });
    return primary;
  }

  const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
  if (remainingMs < MIN_FALLBACK_BUDGET_MS) {
    console.error("primary=openai failed with too little budget left to retry.", {
      primary_failure: primary.kind,
      remaining_ms: remainingMs,
    });
    return primary;
  }

  console.error("primary=openai fallback=gemini", {
    fallback_reason: primary.kind,
    fallback_budget_ms: remainingMs,
  });

  const fallback = await callGemini(input, remainingMs);
  if (fallback.ok) {
    console.warn("fallback=gemini succeeded after primary=openai failed.", {
      fallback_reason: primary.kind,
    });
    return { ok: true, text: fallback.text, provider: "gemini" };
  }

  console.error("primary=openai and fallback=gemini both failed.", {
    primary_failure: primary.kind,
    fallback_failure: fallback.kind,
  });
  // Report the last thing we actually tried, so the message matches reality.
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* OpenAI — primary                                                           */
/* -------------------------------------------------------------------------- */

async function callOpenAI(
  { systemPrompt, userPrompt }: GenerationInput,
  budgetMs: number,
): Promise<Attempt> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set — the primary provider cannot run.");
    return { ok: false, kind: "not_configured" };
  }

  try {
    const response = await new OpenAI({ apiKey }).responses.create(
      {
        model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
        instructions: systemPrompt,
        input: userPrompt,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      },
      // No SDK retries: a whole second provider stands behind this one, so
      // retrying here would only delay reaching it. `timeout` is per attempt,
      // which is exactly the primary's slice of the budget.
      { timeout: budgetMs, maxRetries: 0 },
    );

    if (isOpenAiBlocked(response)) {
      console.error("provider=openai blocked the request.", {
        reason: response.incomplete_details?.reason ?? "refusal",
      });
      return { ok: false, kind: "blocked" };
    }

    const text = readOpenAiText(response);
    if (!text) {
      console.error("provider=openai returned no usable text.", {
        status: response.status,
        incomplete_reason: response.incomplete_details?.reason,
      });
      return { ok: false, kind: "empty_response" };
    }

    return { ok: true, text };
  } catch (error) {
    return classifyOpenAiError(error);
  }
}

/** A refusal part, or a response cut short by the content filter. */
function isOpenAiBlocked(response: OpenAI.Responses.Response): boolean {
  if (response.incomplete_details?.reason === "content_filter") return true;
  return response.output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((part) => part.type === "refusal"),
  );
}

/**
 * `output_text` is the convenience field; assembling it from the output parts is
 * the documented fallback and costs six lines, so we do not depend on it alone.
 */
function readOpenAiText(response: OpenAI.Responses.Response): string {
  if (response.output_text?.trim()) return response.output_text.trim();

  return response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text : ""))
    .join("")
    .trim();
}

function classifyOpenAiError(error: unknown): Attempt {
  logProviderError("openai", error);

  // APIConnectionTimeoutError extends APIConnectionError, so it is checked first.
  if (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIUserAbortError
  ) {
    return { ok: false, kind: "timeout" };
  }
  if (error instanceof APIConnectionError) {
    return { ok: false, kind: "unavailable" };
  }
  if (error instanceof OpenAIApiError) {
    const status = error.status;
    // A rejected key or a model this account cannot reach is our bug to fix.
    if (status === 401 || status === 403 || status === 404) {
      return { ok: false, kind: "not_configured" };
    }
    if (status === 429) {
      return {
        ok: false,
        kind: "rate_limited",
        retryAfterSeconds: readRetryAfter(error.headers),
      };
    }
    if (status === 408 || (status !== undefined && status >= 500)) {
      return { ok: false, kind: "unavailable" };
    }
  }
  return { ok: false, kind: "unknown" };
}

/** Only trust a delay the provider actually told us. Never invent one. */
function readRetryAfter(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* Gemini — fallback                                                          */
/* -------------------------------------------------------------------------- */

async function callGemini(
  { systemPrompt, userPrompt }: GenerationInput,
  budgetMs: number,
): Promise<Attempt> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, kind: "not_configured" };

  try {
    const response = await new GoogleGenAI({ apiKey }).models.generateContent({
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Bounds the whole call, retries included.
        abortSignal: AbortSignal.timeout(budgetMs),
        httpOptions: {
          // 429 is deliberately absent from this list. The SDK retries it by
          // default, but an exhausted quota is not transient — retrying it just
          // spends the fallback's budget on a failure we already know about.
          retryOptions: {
            attempts: 2,
            initialDelay: 0.5,
            maxDelay: 2,
            httpStatusCodes: [500, 502, 503, 504],
          },
        },
      },
    });

    // Gemini can return 200 with no text when a prompt or answer is filtered.
    const blockReason =
      response.promptFeedback?.blockReason ??
      finishReasonIfBlocked(response.candidates?.[0]?.finishReason);
    if (blockReason) {
      console.error("provider=gemini blocked the request.", { blockReason });
      return { ok: false, kind: "blocked" };
    }

    const text = response.text?.trim();
    if (!text) {
      console.error("provider=gemini returned no usable text.", {
        finish_reason: response.candidates?.[0]?.finishReason,
      });
      return { ok: false, kind: "empty_response" };
    }

    return { ok: true, text };
  } catch (error) {
    return classifyGeminiError(error);
  }
}

/** `STOP` and `MAX_TOKENS` are normal endings; the rest mean content was withheld. */
function finishReasonIfBlocked(finishReason: string | undefined) {
  if (!finishReason) return undefined;
  return ["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(
    finishReason,
  )
    ? undefined
    : finishReason;
}

function classifyGeminiError(error: unknown): Attempt {
  logProviderError("gemini", error);

  if (error instanceof GeminiApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return { ok: false, kind: "not_configured" };
    }
    if (error.status === 429) return { ok: false, kind: "rate_limited" };
    if (error.status === 408 || error.status >= 500) {
      return { ok: false, kind: "unavailable" };
    }
  }
  // The SDK surfaces aborts and dropped connections as plain Errors.
  if (error instanceof Error && /abort|timeout/i.test(error.message)) {
    return { ok: false, kind: "timeout" };
  }
  if (error instanceof Error && /fetch failed|network/i.test(error.message)) {
    return { ok: false, kind: "unavailable" };
  }
  return { ok: false, kind: "unknown" };
}

/* -------------------------------------------------------------------------- */

/**
 * A compact, greppable summary — never the whole SDK error object, and never
 * anything derived from the API key.
 */
function logProviderError(provider: ProviderName, error: unknown) {
  const status = error instanceof OpenAIApiError ? error.status : undefined;
  console.error(`provider=${provider} request failed.`, {
    name: error instanceof Error ? error.name : typeof error,
    status: status ?? (error instanceof GeminiApiError ? error.status : undefined),
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
}
