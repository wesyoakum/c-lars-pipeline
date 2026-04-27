// functions/lib/ai-redact.js
//
// Redaction choke-point. Every prompt that leaves Pipeline for an LLM
// provider passes through redactText() first; every response we get back
// passes through unredactText() so the user sees real names again.
//
// Why bother:
//   * Some accounts/opportunities are sensitive (unannounced deals,
//     government security work). Per-record `share_with_ai` gates whether
//     they're shared at all and, if so, whether names are aliased.
//   * Pricing and part numbers are always sensitive. They're tokenized
//     regardless of the per-record flag — the model never needs to see
//     a real PN or a real dollar figure to do its job, so it doesn't.
//
// The model sees stable pseudonyms ("Customer-A", "$PRICE_1$", "$PN_1$").
// Each call carries a `restoreMap` we use to swap the pseudonyms back on
// the way in. The map is built per-call, never persisted, never logged.
//
// Modes (from accounts.share_with_ai or opportunities.share_with_ai):
//   'full'   — names flow through unchanged. Pricing/PNs still tokenized.
//   'alias'  — names replaced with the account's `alias` if set, else a
//              stable pseudonym ("Customer-A"). Pricing/PNs still tokenized.
//   'block'  — caller should not be calling at all. shouldShareWithAi()
//              returns false; redactText() throws if invoked anyway.
//
// The effective mode for a record is the most restrictive of (account,
// opportunity, quote-line context) — see effectiveShareMode().

const PRICE_RE = /(?:USD\s*|US\$|\$)\s?\d[\d,]*(?:\.\d{1,2})?(?!\w)/gi;
const PN_RE = /\b(?:P\/N|PN|MPN|SKU|Part\s*#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-_/.]{2,})/gi;

/**
 * Decide whether a record can be shared with the AI at all.
 *   block → false. full / alias / null/undefined → true.
 */
export function shouldShareWithAi(mode) {
  return normalizeMode(mode) !== 'block';
}

/**
 * Combine multiple per-record modes (account, opp, etc.) into the most
 * restrictive one. block beats alias beats full. Unknowns default to full.
 */
export function effectiveShareMode(...modes) {
  let result = 'full';
  for (const raw of modes) {
    const m = normalizeMode(raw);
    if (m === 'block') return 'block';
    if (m === 'alias') result = 'alias';
  }
  return result;
}

function normalizeMode(m) {
  const v = (m || '').toString().trim().toLowerCase();
  if (v === 'block' || v === 'alias' || v === 'full') return v;
  return 'full';
}

/**
 * Build a redaction context from a list of named entities (accounts,
 * contacts, etc.). Pass this into redactText() so account/contact names
 * are swapped for stable pseudonyms.
 *
 * @param {object} opts
 * @param {string} opts.mode                  'full' | 'alias' | 'block'
 * @param {Array<{name: string, alias?: string}>} [opts.accounts]
 * @param {Array<{name: string}>}             [opts.contacts]
 * @returns {{mode: string, replacements: Array<{from: string, to: string}>, restoreMap: Map<string,string>}}
 */
export function buildRedactionContext(opts) {
  const mode = normalizeMode(opts.mode);
  if (mode === 'block') {
    throw new Error('Refusing to build redaction context for block-mode record.');
  }

  const replacements = [];
  const restoreMap = new Map();

  if (mode === 'alias') {
    let acctIdx = 0;
    for (const acct of opts.accounts || []) {
      if (!acct?.name) continue;
      const pseudo = acct.alias && acct.alias.trim()
        ? acct.alias.trim()
        : `Customer-${letter(acctIdx++)}`;
      replacements.push({ from: acct.name, to: pseudo });
      restoreMap.set(pseudo, acct.name);
    }

    let contactIdx = 0;
    for (const contact of opts.contacts || []) {
      if (!contact?.name) continue;
      const pseudo = `Contact-${letter(contactIdx++)}`;
      replacements.push({ from: contact.name, to: pseudo });
      restoreMap.set(pseudo, contact.name);
    }
  }

  return { mode, replacements, restoreMap };
}

/**
 * Redact a string for outbound use. Always tokenizes pricing/PNs; also
 * applies name swaps if the context is alias-mode.
 *
 * Returns { text, restoreMap } — pass restoreMap to unredactText() on the
 * response. The map is augmented with whatever pricing/PN tokens we
 * generated, on top of the name pseudonyms from buildRedactionContext().
 */
export function redactText(input, ctx) {
  if (input == null) return { text: '', restoreMap: new Map() };
  if (ctx?.mode === 'block') {
    throw new Error('Refusing to redact text for block-mode record.');
  }

  let text = String(input);
  const restoreMap = new Map(ctx?.restoreMap || []);

  // Name replacements first (longest first, so "Acme Aerospace Inc"
  // doesn't get partially clobbered by a shorter "Acme" entry).
  const sorted = [...(ctx?.replacements || [])]
    .filter((r) => r?.from)
    .sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of sorted) {
    text = replaceAllLiteral(text, from, to);
  }

  // Pricing always tokenized.
  let priceIdx = 0;
  text = text.replace(PRICE_RE, (match) => {
    const token = `$PRICE_${++priceIdx}$`;
    restoreMap.set(token, match);
    return token;
  });

  // Part numbers always tokenized.
  let pnIdx = 0;
  text = text.replace(PN_RE, (match, captured) => {
    const token = `$PN_${++pnIdx}$`;
    restoreMap.set(token, match);
    // Replace the entire matched string (label + value), not just the value.
    return token;
  });

  return { text, restoreMap };
}

/**
 * Reverse a redaction. Walks every token in restoreMap and swaps it back
 * to the original value. Safe to call on JSON-shaped strings or free text.
 */
export function unredactText(input, restoreMap) {
  if (input == null) return '';
  if (!restoreMap || restoreMap.size === 0) return String(input);

  let text = String(input);
  // Longest-first so "$PRICE_10$" doesn't get clobbered by "$PRICE_1$".
  const tokens = [...restoreMap.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    text = replaceAllLiteral(text, token, restoreMap.get(token));
  }
  return text;
}

/**
 * Walk a JSON value and unredact every string leaf in place. Used after
 * structured extraction so account/contact names come back real.
 */
export function unredactJson(value, restoreMap) {
  if (value == null || !restoreMap || restoreMap.size === 0) return value;
  if (typeof value === 'string') return unredactText(value, restoreMap);
  if (Array.isArray(value)) return value.map((v) => unredactJson(v, restoreMap));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = unredactJson(v, restoreMap);
    }
    return out;
  }
  return value;
}

function replaceAllLiteral(haystack, needle, replacement) {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

function letter(n) {
  // 0 → A, 25 → Z, 26 → AA, ... keeps pseudonyms short and stable.
  let s = '';
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}
