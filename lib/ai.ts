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

// One ceiling for the whole request. OpenAI gets 30s and the fallback gets
// what's left, so adding a second provider can't double how long a user waits.
const TOTAL_BUDGET_MS = 50_000;
const PRIMARY_BUDGET_MS = 30_000;
// Below this a fallback can't realistically finish, so we don't start one.
const MIN_FALLBACK_BUDGET_MS = 10_000;

export type ProviderName = "openai" | "gemini";

export type FailureKind =
  | "not_configured"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "blocked"
  | "empty_response"
  | "unknown";

// Only fall back when the provider is up but can't serve us right now.
// not_configured, blocked, empty_response and unknown are left out on purpose:
// swapping providers there hides a bug or second-guesses a safety decision
// instead of fixing anything.
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
  systemPrompt: string;
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
  return fallback;
}

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
      // No SDK retries on purpose: Gemini is the retry. The SDK timeout is per
      // attempt, so retrying here would also push us past the total budget.
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

function isOpenAiBlocked(response: OpenAI.Responses.Response): boolean {
  if (response.incomplete_details?.reason === "content_filter") return true;
  return response.output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((part) => part.type === "refusal"),
  );
}

function readOpenAiText(response: OpenAI.Responses.Response): string {
  if (response.output_text?.trim()) return response.output_text.trim();

  // output_text is a convenience field. Rebuilding it from the output parts is
  // the documented fallback, and it's cheap enough not to depend on one field.
  return response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text : ""))
    .join("")
    .trim();
}

function classifyOpenAiError(error: unknown): Attempt {
  logProviderError("openai", error);

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
    // Bad key, or a model this account can't reach. That's our bug to fix, and
    // 404 lands here so a retired model name doesn't read as a random failure.
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

function readRetryAfter(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : undefined;
}

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
        abortSignal: AbortSignal.timeout(budgetMs),
        httpOptions: {
          retryOptions: {
            attempts: 2,
            initialDelay: 0.5,
            maxDelay: 2,
            // 429 is missing here on purpose. The SDK retries it by default,
            // but an exhausted quota isn't transient, so those retries just
            // spend the remaining budget on a failure we already know about.
            httpStatusCodes: [500, 502, 503, 504],
          },
        },
      },
    });

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

// STOP and MAX_TOKENS are normal endings. Any other reason means Gemini
// withheld the content, which is a different problem than a failed request.
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
  if (error instanceof Error && /abort|timeout/i.test(error.message)) {
    return { ok: false, kind: "timeout" };
  }
  if (error instanceof Error && /fetch failed|network/i.test(error.message)) {
    return { ok: false, kind: "unavailable" };
  }
  return { ok: false, kind: "unknown" };
}

function logProviderError(provider: ProviderName, error: unknown) {
  const status = error instanceof OpenAIApiError ? error.status : undefined;
  console.error(`provider=${provider} request failed.`, {
    name: error instanceof Error ? error.name : typeof error,
    status: status ?? (error instanceof GeminiApiError ? error.status : undefined),
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
}
