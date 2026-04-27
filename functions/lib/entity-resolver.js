// functions/lib/entity-resolver.js
//
// Resolve people/organizations from a free-text extraction against
// existing CRM rows (accounts, contacts). Returns top-3 candidates per
// mention with a numeric score and an auto_resolved flag.
//
// Used by AI Inbox v2 today; designed so RFQ Intake and NBA Coach can
// import the same module later — they pass the same shape and consume
// the same candidate list.
//
// Algorithm (mirrors functions/board/mention-search.js):
//   - Score per match: exact 100, prefix 80, substring 40.
//   - Organizations: search accounts.name, alias, parent_group.
//                    -20 penalty when is_active = 0.
//   - People: search contacts.first_name / last_name / first||' '||last.
//             +30 boost when contact.account_id is one of the orgs that
//             scored >= 100 (clear winner) — tightens "Jane mentioned
//             alongside Acme" to Jane @ Acme.
//             -20 penalty when the contact's account is_active = 0.
//   - Auto-resolve: rank-1 row gets auto_resolved=1 when its score is
//                   >= 100 AND the gap to rank-2 is >= 40.

import { all } from './db.js';

/**
 * Resolve every mention in an extraction. Returns an array of candidate
 * rows ready to insert into ai_inbox_entity_matches (the caller adds
 * id / created_at / updated_at).
 *
 * Input:
 *   { people: ['Jane Smith', ...],
 *     organizations: ['Acme Inc.', ...] }
 *
 * Output (one row per (mention, candidate)):
 *   { mention_kind: 'person'|'organization',
 *     mention_text, mention_idx,
 *     ref_type: 'account'|'contact', ref_id, ref_label,
 *     score, rank, auto_resolved, user_overridden: 0 }
 */
export async function resolveEntities(db, { people = [], organizations = [] }) {
  const orgMatches = await Promise.all(
    organizations.map((text, idx) => resolveOrg(db, text, idx))
  );
  // Flatten resolved orgs to a set of confirmed account ids — used to
  // boost contact candidates whose account matches.
  const confirmedAccountIds = new Set();
  for (const m of orgMatches.flat()) {
    if (m.score >= 100) confirmedAccountIds.add(m.ref_id);
  }
  const personMatches = await Promise.all(
    people.map((text, idx) => resolvePerson(db, text, idx, confirmedAccountIds))
  );
  return [...orgMatches.flat(), ...personMatches.flat()];
}

async function resolveOrg(db, text, mention_idx) {
  const q = (text || '').trim();
  if (!q) return [];
  const like = `%${q.toLowerCase()}%`;
  const rows = await all(db,
    `SELECT id, name, alias, parent_group, is_active
       FROM accounts
      WHERE LOWER(name) LIKE ?
         OR LOWER(COALESCE(alias,'')) LIKE ?
         OR LOWER(COALESCE(parent_group,'')) LIKE ?
      LIMIT 25`,
    [like, like, like]);

  const scored = rows.map(r => {
    const fields = [r.name, r.alias, r.parent_group].filter(Boolean);
    const best = Math.max(...fields.map(f => scoreMatch(f, q)));
    const penalty = r.is_active === 0 ? -20 : 0;
    return {
      mention_kind: 'organization',
      mention_text: text,
      mention_idx,
      ref_type: 'account',
      ref_id: r.id,
      ref_label: r.alias || r.name,
      score: best + penalty,
    };
  }).filter(x => x.score > 0);

  return rankTop3(scored);
}

async function resolvePerson(db, text, mention_idx, confirmedAccountIds) {
  const q = (text || '').trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const first = tokens[0].toLowerCase();
  const last = tokens.length > 1 ? tokens[tokens.length - 1].toLowerCase() : null;

  const rows = await all(db,
    `SELECT c.id, c.first_name, c.last_name, c.email, c.account_id,
            a.name AS account_name, a.alias AS account_alias, a.is_active AS account_active
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
      WHERE LOWER(COALESCE(c.first_name,'')) LIKE ?
         OR LOWER(COALESCE(c.last_name,'')) LIKE ?
         OR LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE ?
      LIMIT 50`,
    [`%${first}%`, last ? `%${last}%` : `%${first}%`, `%${q.toLowerCase()}%`]);

  const scored = rows.map(r => {
    const full = `${r.first_name || ''} ${r.last_name || ''}`.trim();
    const base = scoreMatch(full, q);
    const orgBoost = confirmedAccountIds.has(r.account_id) ? 30 : 0;
    const penalty = r.account_active === 0 ? -20 : 0;
    return {
      mention_kind: 'person',
      mention_text: text,
      mention_idx,
      ref_type: 'contact',
      ref_id: r.id,
      ref_label: full + (r.account_name ? ` · ${r.account_alias || r.account_name}` : ''),
      score: base + orgBoost + penalty,
    };
  }).filter(x => x.score > 0);

  return rankTop3(scored);
}

function scoreMatch(label, q) {
  const s = (label || '').toLowerCase();
  const qq = q.toLowerCase();
  if (s === qq) return 100;
  if (s.indexOf(qq) === 0) return 80;
  if (s.indexOf(qq) >= 0) return 40;
  return 0;
}

function rankTop3(scored) {
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  // Auto-resolve when #1 is a clear winner (>=100 with >=40 gap to #2).
  const autoResolved = top.length > 0 && top[0].score >= 100 &&
                       (top.length < 2 || top[0].score - top[1].score >= 40);
  return top.map((x, i) => ({
    ...x,
    rank: i + 1,
    auto_resolved: autoResolved && i === 0 ? 1 : 0,
    user_overridden: 0,
  }));
}
