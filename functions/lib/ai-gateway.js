// functions/lib/ai-gateway.js
//
// Single choke-point for "what URL do AI calls go to?" Every provider call
// routes through here so that turning Cloudflare AI Gateway on or off is
// one env-var flip, not a code change.
//
// Cloudflare AI Gateway is a transparent proxy that gives us per-call logs,
// caching, retries, and unified cost tracking across providers. The wire
// format is identical to the upstream provider — only the base URL changes.
//
// Configuration (set via `wrangler pages secret put` or .dev.vars):
//   AI_GATEWAY_ACCOUNT_ID  Cloudflare account id (the gateway is per-account)
//   AI_GATEWAY_NAME        Gateway slug, e.g. 'c-lars-pms'
//
// When both are set, calls go to:
//   https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>
// Otherwise calls go direct to the provider.

const PROVIDER_DIRECT = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

/**
 * Return the base URL for a given provider, factoring in whether AI Gateway
 * is configured. Use this everywhere instead of hard-coding a provider URL.
 *
 * @param {object} env       Pages Functions env
 * @param {string} provider  'openai' | 'anthropic'
 * @returns {string}         base URL with no trailing slash
 */
export function aiBaseUrl(env, provider) {
  const direct = PROVIDER_DIRECT[provider];
  if (!direct) throw new Error(`Unknown AI provider: ${provider}`);

  const account = env.AI_GATEWAY_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_NAME;
  if (!account || !gateway) return direct;

  return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/${provider}`;
}

/**
 * True iff AI Gateway is configured. Useful for logging which path a call
 * took, or for skipping cache-control headers when running direct.
 */
export function isGatewayEnabled(env) {
  return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_NAME);
}
