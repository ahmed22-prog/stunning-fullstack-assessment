/**
 * Validation rules shared by the browser and the API route.
 *
 * This lives in its own module so the client component never imports
 * lib/prompt.ts — the system-prompt text stays server-side by construction
 * rather than by relying on the bundler to tree-shake it away.
 */

export const PROMPT_MAX_LENGTH = 2000;
