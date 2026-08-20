import { INTEGRATIONS, resolveIntegrationNames } from "@/lib/integrations";
import { buildSystemPrompt } from "@/lib/prompt";
import { PROMPT_MAX_LENGTH } from "@/lib/validation";
import { checkRateLimit } from "@/lib/rate-limit";
import { generatePlan, type FailureKind } from "@/lib/ai";

type ErrorCode =
  | "invalid_request"
  | "rate_limited"
  | "not_configured"
  | "blocked"
  | "service_unavailable"
  | "timeout"
  | "empty_response"
  | "server_error";

function fail(
  code: ErrorCode,
  message: string,
  status: number,
  retryAfterSeconds?: number,
) {
  return Response.json(
    { error: message, code },
    {
      status,
      headers: retryAfterSeconds
        ? { "Retry-After": String(retryAfterSeconds) }
        : undefined,
    },
  );
}

export async function POST(request: Request) {
  const { allowed, retryAfterSeconds } = checkRateLimit(getClientKey(request));
  if (!allowed) {
    return fail(
      "rate_limited",
      `Too many requests. Try again in ${retryAfterSeconds}s.`,
      429,
      retryAfterSeconds,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_request", "Request body must be valid JSON.", 400);
  }

  const parsed = parseBody(body);
  if ("error" in parsed) {
    return fail("invalid_request", parsed.error, 400);
  }

  const result = await generatePlan({
    systemPrompt: buildSystemPrompt(parsed.integrationNames),
    userPrompt: parsed.prompt,
  });

  if (!result.ok) {
    return failFromProvider(result.kind, result.retryAfterSeconds);
  }

  // Which provider answered is useful in the logs, but the browser doesn't
  // need it, so it stays out of the response body.
  console.info("Plan generated.", { provider: result.provider });
  return Response.json({ text: result.text });
}

function failFromProvider(kind: FailureKind, retryAfterSeconds?: number) {
  switch (kind) {
    case "not_configured":
      return fail(
        "not_configured",
        "The server's AI provider is not configured correctly. Please contact the site owner.",
        500,
      );
    case "rate_limited":
      return fail(
        "rate_limited",
        "The AI service request limit has been reached. Please try again later.",
        429,
        retryAfterSeconds,
      );
    case "unavailable":
      return fail(
        "service_unavailable",
        "The AI service is temporarily unavailable. Please try again in a moment.",
        503,
      );
    case "timeout":
      return fail(
        "timeout",
        "The AI service took too long to respond. Please try again.",
        504,
      );
    case "blocked":
      return fail(
        "blocked",
        "The safety filter blocked this request. Try rephrasing your description.",
        422,
      );
    case "empty_response":
      return fail(
        "empty_response",
        "The model did not return a usable response. Please try again.",
        502,
      );
    default:
      return fail(
        "server_error",
        "Something went wrong generating your plan. Please try again.",
        500,
      );
  }
}

type ParsedBody =
  | { prompt: string; integrationNames: string[] }
  | { error: string };

function parseBody(body: unknown): ParsedBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const { prompt, integrations } = body as Record<string, unknown>;

  if (typeof prompt !== "string") {
    return { error: "`prompt` is required and must be a string." };
  }

  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length === 0) {
    return { error: "Please describe what you want to build." };
  }
  if (trimmedPrompt.length > PROMPT_MAX_LENGTH) {
    return {
      error: `Your description is too long. Please keep it to ${PROMPT_MAX_LENGTH} characters or fewer.`,
    };
  }

  if (integrations !== undefined && !Array.isArray(integrations)) {
    return { error: "`integrations` must be an array of integration ids." };
  }

  const ids = integrations ?? [];
  if (!ids.every((id): id is string => typeof id === "string")) {
    return { error: "`integrations` must contain only strings." };
  }

  const resolved = resolveIntegrationNames(ids);
  if (!resolved.ok) {
    return {
      error: `Unknown integration${resolved.unknownIds.length > 1 ? "s" : ""}. Choose from: ${INTEGRATIONS.map((i) => i.id).join(", ")}.`,
    };
  }

  return { prompt: trimmedPrompt, integrationNames: resolved.names };
}

function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}
