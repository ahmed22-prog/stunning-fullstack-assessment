"use client";

import { useMemo, useRef, useState } from "react";
import { INTEGRATIONS } from "@/lib/integrations";
import { PROMPT_MAX_LENGTH } from "@/lib/validation";

type Status = "idle" | "loading" | "success" | "error";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  // `status` lags a synchronous burst of clicks by a render, so it cannot guard
  // against double submits on its own. This ref flips immediately.
  const inFlight = useRef(false);

  // The server validates the *trimmed* prompt, so the counter and the limit
  // check have to use the same number. Measuring raw length here used to block
  // input the API would have accepted, e.g. a full-length paste ending in a
  // newline.
  const trimmedLength = prompt.trim().length;
  const isTooLong = trimmedLength > PROMPT_MAX_LENGTH;
  const canSubmit = trimmedLength > 0 && !isTooLong && status !== "loading";

  const selectedNames = useMemo(
    () =>
      INTEGRATIONS.filter((i) => selectedIds.includes(i.id)).map((i) => i.name),
    [selectedIds],
  );

  function handlePromptChange(value: string) {
    setPrompt(value);
    // A failed attempt is about the text the user just changed, so stop showing
    // it. A successful plan stays put — they are probably still reading it.
    if (status === "error") {
      setStatus("idle");
      setError(null);
    }
  }

  function toggleIntegration(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((existing) => existing !== id)
        : [...current, id],
    );
  }

  async function handleGenerate() {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;

    setStatus("loading");
    setError(null);
    setResult(null);
    setCanRetry(true);
    setCopyState("idle");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          integrations: selectedIds,
        }),
      });

      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(readError(data));
        setCanRetry(isRetryable(readCode(data)));
        setStatus("error");
        return;
      }

      const text = readText(data);
      if (!text) {
        setError("The server returned an empty response. Please try again.");
        setCanRetry(true);
        setStatus("error");
        return;
      }

      setResult(text);
      setStatus("success");
    } catch {
      setError(
        "We couldn't reach the server. Check your connection and try again.",
      );
      setCanRetry(true);
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <div className="relative flex min-h-full flex-col overflow-x-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,rgba(249,115,98,0.14),transparent_70%)]"
      />

      <main className="relative mx-auto w-full max-w-3xl grow px-5 py-12 sm:px-8 sm:py-20">
        <header className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-accent" />
          <span className="text-sm font-semibold tracking-tight text-ink">
            Stunning
          </span>
        </header>

        <div className="mt-12 sm:mt-16">
          <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
            Describe it.
            <br />
            <span className="text-ink-muted">Get the build plan.</span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-ink-muted">
            Tell us what you want to build and which services it should talk to.
            You get scoped features, an integration plan, and a first milestone.
          </p>
        </div>

        <section className="mt-10 rounded-2xl border border-border-subtle bg-surface p-5 shadow-2xl shadow-black/40 sm:mt-12 sm:p-6">
          <label htmlFor="prompt" className="block text-sm font-medium text-ink">
            What are you building?
          </label>
          <textarea
            id="prompt"
            value={prompt}
            dir="auto"
            onChange={(event) => handlePromptChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                // Holding the shortcut auto-repeats; one press means one plan.
                if (event.repeat) return;
                void handleGenerate();
              }
            }}
            rows={5}
            placeholder="A subscription box store where customers pick a plan, get billed monthly, and receive a shipping email when their order goes out."
            aria-describedby="prompt-meta"
            aria-invalid={isTooLong}
            className="mt-3 w-full resize-y rounded-xl border border-border-subtle bg-canvas px-4 py-3.5 text-[15px] leading-relaxed text-ink placeholder:text-ink-subtle focus-visible:border-border-strong"
          />
          <div
            id="prompt-meta"
            className="mt-2 flex items-center justify-between gap-3 text-xs"
          >
            <span className="text-ink-subtle">
              <kbd className="font-mono">Ctrl</kbd>
              <span className="mx-1">+</span>
              <kbd className="font-mono">Enter</kbd> to generate
            </span>
            <span
              className={
                isTooLong ? "font-medium text-danger" : "text-ink-subtle"
              }
            >
              {trimmedLength.toLocaleString()} /{" "}
              {PROMPT_MAX_LENGTH.toLocaleString()}
            </span>
          </div>

          <fieldset className="mt-7 border-t border-border-subtle pt-6">
            <legend className="sr-only">Integrations</legend>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm font-medium text-ink">Integrations</span>
              <span className="text-xs text-ink-subtle">
                {selectedNames.length === 0
                  ? "Optional - none selected"
                  : selectedNames.join(", ")}
              </span>
            </div>

            <div className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {INTEGRATIONS.map((integration) => {
                const isSelected = selectedIds.includes(integration.id);
                return (
                  <button
                    key={integration.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggleIntegration(integration.id)}
                    className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? "border-accent/60 bg-accent/10"
                        : "border-border-subtle bg-surface-raised hover:border-border-strong"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none ${
                        isSelected
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-border-strong text-transparent"
                      }`}
                    >
                      &#10003;
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {integration.name}
                      </span>
                      <span className="block truncate text-xs text-ink-subtle">
                        {integration.blurb}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canSubmit}
            className="mt-7 flex w-full items-center justify-center gap-2.5 rounded-xl bg-accent px-5 py-3.5 text-[15px] font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {status === "loading" ? (
              <>
                <Spinner />
                Generating
              </>
            ) : (
              "Generate plan"
            )}
          </button>
        </section>

        <section aria-live="polite" className="mt-8">
          {status === "loading" && <LoadingPanel />}

          {status === "error" && error && (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-danger">
                Couldn&apos;t generate a plan
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
                {error}
              </p>
              {/* Hidden for errors a retry can't fix, like an exhausted quota
                  or a server that isn't configured. */}
              {canRetry && (
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={!canSubmit}
                  className="mt-4 rounded-lg border border-border-strong px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-raised disabled:opacity-40"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {status === "success" && result && (
            <article className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
              <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-5 py-2 sm:px-6">
                <h2 className="text-sm font-semibold text-ink">
                  Your build plan
                </h2>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex min-h-11 min-w-16 items-center justify-center rounded-lg border border-border-subtle px-3 text-xs font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                >
                  {copyState === "copied"
                    ? "Copied"
                    : copyState === "failed"
                      ? "Copy failed"
                      : "Copy"}
                </button>
              </div>
              <div className="px-5 py-5 sm:px-6 sm:py-6">
                <p
                  dir="auto"
                  className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]"
                >
                  {result}
                </p>
              </div>
            </article>
          )}

          {status === "idle" && (
            <div className="rounded-2xl border border-dashed border-border-subtle px-5 py-10 text-center sm:py-12">
              <p className="text-sm font-medium text-ink">
                Your plan will appear here
              </p>
              <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-subtle">
                Selected integrations change how the plan is written. Pick the
                ones your product actually needs.
              </p>
            </div>
          )}
        </section>
      </main>

      <footer className="relative mx-auto w-full max-w-3xl px-5 pb-10 sm:px-8">
        <p className="text-xs text-ink-subtle">
          Integrations are illustrative context for the model. No third-party
          service is connected.
        </p>
      </footer>
    </div>
  );
}

function LoadingPanel() {
  const skeletonWidths = ["w-1/3", "w-full", "w-11/12", "w-2/5", "w-full", "w-4/5"];

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex items-center gap-2.5">
        <Spinner className="text-accent" />
        <p className="text-sm font-medium text-ink">Writing your plan</p>
      </div>
      <div className="mt-5 space-y-2.5" aria-hidden>
        {skeletonWidths.map((width, index) => (
          <div
            key={index}
            className={`h-3 animate-pulse rounded bg-border-subtle ${width}`}
            style={{ animationDelay: `${index * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`size-4 animate-spin ${className}`}
      fill="none"
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function readText(data: unknown): string {
  if (data && typeof data === "object") {
    const { text } = data as { text?: unknown };
    if (typeof text === "string") return text.trim();
  }
  return "";
}

function readError(data: unknown): string {
  if (data && typeof data === "object") {
    const { error } = data as { error?: unknown };
    if (typeof error === "string" && error.trim()) return error;
  }
  return "Something went wrong. Please try again.";
}

function readCode(data: unknown): string {
  if (data && typeof data === "object") {
    const { code } = data as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return "";
}

function isRetryable(code: string): boolean {
  return !["rate_limited", "not_configured", "blocked", "invalid_request"].includes(
    code,
  );
}
