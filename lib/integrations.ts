/**
 * The single trusted source of truth for integrations.
 *
 * The browser sends integration *ids*. The server never trusts them directly —
 * every id is resolved against this list before its display name is allowed
 * anywhere near the model prompt.
 */

export type Integration = {
  id: string;
  name: string;
  /** Short label shown under the name in the selector. UI only. */
  blurb: string;
};

export const INTEGRATIONS: readonly Integration[] = [
  { id: "stripe", name: "Stripe", blurb: "Payments & subscriptions" },
  { id: "shopify", name: "Shopify", blurb: "Storefront & orders" },
  { id: "gmail", name: "Gmail", blurb: "Transactional email" },
  { id: "slack", name: "Slack", blurb: "Team notifications" },
  { id: "google-sheets", name: "Google Sheets", blurb: "Lightweight reporting" },
];

const INTEGRATIONS_BY_ID = new Map(INTEGRATIONS.map((i) => [i.id, i]));

export type ResolveResult =
  | { ok: true; names: string[] }
  | { ok: false; unknownIds: string[] };

/**
 * Resolve client-supplied ids to trusted display names.
 *
 * Duplicates are collapsed. Any id that is not in the allowlist fails the
 * whole request — see DECISIONS.md for why we reject rather than silently drop.
 */
export function resolveIntegrationNames(ids: string[]): ResolveResult {
  const unknownIds: string[] = [];
  const names = new Set<string>();

  for (const id of ids) {
    const integration = INTEGRATIONS_BY_ID.get(id);
    if (integration) {
      names.add(integration.name);
    } else {
      unknownIds.push(id);
    }
  }

  if (unknownIds.length > 0) {
    return { ok: false, unknownIds };
  }

  // Return them in the canonical order defined above, not the client's order.
  return {
    ok: true,
    names: INTEGRATIONS.filter((i) => names.has(i.name)).map((i) => i.name),
  };
}
