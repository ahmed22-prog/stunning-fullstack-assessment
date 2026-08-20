export type Integration = {
  id: string;
  name: string;
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

  return {
    ok: true,
    names: INTEGRATIONS.filter((i) => names.has(i.name)).map((i) => i.name),
  };
}
