// functions/ai-inbox/_diag.js
//
// GET /ai-inbox/_diag
//
// Temporary diagnostic. Makes a tiny test call to OpenAI through the
// configured AI Gateway and returns the raw status + body so we can see
// exactly why authentication is failing. Returns ONLY non-sensitive
// fields — never echoes the OpenAI key or gateway token.
//
// SAFE TO REMOVE once gateway auth is working.
// (rev2: forces redeploy so updated AI_GATEWAY_ACCOUNT_ID secret takes effect)

import { aiBaseUrl, isGatewayEnabled, gatewayHeaders } from '../lib/ai-gateway.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const { env } = context;

  const baseUrl = aiBaseUrl(env, 'openai');
  const url = `${baseUrl}/chat/completions`;
  const tokenSet = !!env.AI_GATEWAY_TOKEN;
  const openaiKeySet = !!env.OPENAI_API_KEY;
  const gatewayHeadersBuilt = gatewayHeaders(env);
  const gatewayHeaderPresent = !!gatewayHeadersBuilt['cf-aig-authorization'];

  const probe = {
    gateway_enabled: isGatewayEnabled(env),
    gateway_url_base: baseUrl,
    openai_key_set: openaiKeySet,
    gateway_token_set: tokenSet,
    gateway_header_will_be_sent: gatewayHeaderPresent,
  };

  if (!openaiKeySet) {
    return json({ ...probe, error: 'OPENAI_API_KEY not set' }, 500);
  }

  let resp, bodyText;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
        ...gatewayHeadersBuilt,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    bodyText = await resp.text();
  } catch (e) {
    return json({ ...probe, fetch_error: String(e.message || e) }, 500);
  }

  return json({
    ...probe,
    response_status: resp.status,
    response_body_first_400_chars: bodyText.slice(0, 400),
  });
}
