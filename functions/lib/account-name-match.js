// functions/lib/account-name-match.js
//
// Token-subset account-name matcher used by Claudia's search_accounts
// tool (and any future flow that needs "is this name probably the
// same as one of these stored accounts?").
//
// The problem the substring-LIKE matcher had: an email signature
// said "Acme Industrial Group, LLC" but the Pipeline row was just
// "Acme Industrial Group", so search_accounts(query="Acme Industrial
// Group, LLC") returned zero rows and Claudia proposed a duplicate.
// Conversely she'd query "drift offshore" and miss a row stored as
// "Drift" because LIKE '%drift offshore%' doesn't match "Drift".
//
// Approach:
//   1. normalize() — lowercase, strip parentheticals/punctuation,
//      strip leading "the", strip a long list of corporate suffixes
//      (US + international), tokenize on whitespace.
//   2. matchScore(qTokens, rTokens) — returns 'exact' (sets equal),
//      'query_subset' (every query token in row), 'row_subset' (every
//      row token in query), or null. Either-side subset counts as a
//      hit because the user could be searching with the long form
//      OR the short form.
//
// Wes called these out specifically as suffixes that should not
// affect matching: inc, llc, AS, SA, SSAA, "and associates". This
// list adds more international forms (gmbh, ag, oy, ab, srl, kk,
// pty, plc, bhd, sdn — C-LARS sells globally so they show up).
//
// Cheap (no full-text index, runs over ~thousands of rows in JS).
// Caller pulls candidate rows with a coarse SQL prefilter (first
// normalized token via LIKE) then runs each row through matchScore.

// Single-word corporate suffixes stripped from the END of a name.
// All lowercase here; normalize() lowercases before lookup.
const SUFFIX_TOKENS = new Set([
  // US
  'inc', 'incorporated', 'llc', 'l.l.c', 'lp', 'llp', 'pllc', 'pc',
  'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'companies',
  'holdings', 'holding', 'group',
  // UK / Commonwealth
  'plc', 'pty', 'pte',
  // Germany / Austria / Switzerland
  'gmbh', 'mbh', 'ag', 'kg',
  // Netherlands / Belgium
  'nv', 'bv',
  // France / Spain / Italy / Portugal / Latin America
  'sa', 'sas', 'sarl', 'srl', 'spa', 'lda',
  // Nordics
  'as', 'ab', 'oy', 'oyj', 'aps',
  // Japan / Korea
  'kk', 'kabushiki', 'kabushikigaisha',
  // SE Asia
  'bhd', 'sdn',
  // Wes-specific tokens that should never affect matching
  'ssaa',
]);

// Multi-word patterns stripped from the END of a name BEFORE
// tokenization. Anchored to end via $; case-insensitive (input is
// already lowercased by the time the regex runs).
const MULTI_WORD_SUFFIX_RE = /\s+(?:and|&)\s+(?:associates|sons|partners|company|companies|brothers|bros)$/;

/**
 * Normalize a raw account/company name into a clean token list.
 *
 * Examples:
 *   "Drift Offshore"           → ['drift', 'offshore']
 *   "Drift Offshore, Inc."     → ['drift', 'offshore']
 *   "Drift"                    → ['drift']
 *   "Acme & Associates"        → ['acme']
 *   "DeepSea Survey AS"        → ['deepsea', 'survey']
 *   "Helix Robotics"           → ['helix', 'robotics']
 *   "The Acme Holdings Group"  → ['acme']
 *
 * Returns an empty array for null/empty/all-suffix input.
 */
export function normalizeAccountName(raw) {
  if (raw == null) return [];
  let t = String(raw).toLowerCase();
  // Strip a trailing parenthetical: "Acme (USA)" → "Acme"
  t = t.replace(/\s*\([^)]*\)\s*$/g, '');
  // Replace common separators with spaces; ampersand becomes "and"
  // so "B&B" → "b and b" tokenizes consistently
  t = t.replace(/&/g, ' and ');
  t = t.replace(/[.,/\\\-_'"`]/g, ' ');
  // Collapse multiple spaces
  t = t.replace(/\s+/g, ' ').trim();
  // Strip multi-word suffix patterns at the end (chain — repeat
  // until the regex stops matching, in case of "Acme and Sons and
  // Associates")
  let prev;
  do {
    prev = t;
    t = t.replace(MULTI_WORD_SUFFIX_RE, '');
  } while (t !== prev);
  // Tokenize and strip single-word suffixes from the end (chain —
  // "Acme Inc Holdings" → "acme")
  let tokens = t.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  // Strip leading "the" if there's still something behind it
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  return tokens;
}

/**
 * Compare two normalized token lists. Returns:
 *   'exact'         — same set (regardless of order)
 *   'query_subset'  — every query token appears in row tokens
 *                     (e.g. query "drift" matches row "drift offshore")
 *   'row_subset'    — every row token appears in query tokens
 *                     (e.g. query "drift offshore inc" matches row "drift")
 *   null            — no match
 */
export function matchScore(qTokens, rTokens) {
  if (!Array.isArray(qTokens) || !Array.isArray(rTokens)) return null;
  if (qTokens.length === 0 || rTokens.length === 0) return null;
  const qSet = new Set(qTokens);
  const rSet = new Set(rTokens);
  const allQinR = qTokens.every((t) => rSet.has(t));
  const allRinQ = rTokens.every((t) => qSet.has(t));
  if (allQinR && allRinQ) return 'exact';
  if (allQinR) return 'query_subset';
  if (allRinQ) return 'row_subset';
  return null;
}

/**
 * Convenience: compare two raw strings end-to-end. Used for ad-hoc
 * checks; the search path uses normalize + matchScore separately so
 * the row tokens get computed once per row.
 */
export function rawAccountNameMatch(query, candidate) {
  return matchScore(normalizeAccountName(query), normalizeAccountName(candidate));
}

/**
 * Numeric rank for sorting matched candidates — smaller is better.
 * Use as the secondary sort key after exact-set; ties broken by
 * shorter row name (more specific row wins).
 */
export function matchRank(score) {
  switch (score) {
    case 'exact':         return 0;
    case 'query_subset':  return 1; // "drift" → "Drift Offshore"
    case 'row_subset':    return 2; // "drift offshore inc" → "Drift"
    default:              return 99;
  }
}
