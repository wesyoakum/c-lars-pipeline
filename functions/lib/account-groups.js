// functions/lib/account-groups.js
//
// Helpers for the label-based parent/child account grouping.
// `accounts.parent_group` is a free-text label (e.g. "Super Big Corp");
// this module converts between the display label, a URL-safe slug,
// and a D1 query that looks up all accounts sharing a group.
//
// The slug is lowercase, non-alphanumerics collapsed to hyphens, and
// trimmed of leading/trailing hyphens. It is NOT stored anywhere —
// it exists only so /accounts/group/:slug URLs are friendly. Lookups
// are O(N) in the size of the non-null parent_group accounts, which
// is fine for our scale and avoids keeping a denormalized slug column
// in sync with the label.

import { all } from './db.js';

/** Convert a group label into a URL-safe slug. Returns '' for empty. */
export function slugifyGroup(label) {
  if (!label) return '';
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Look up every account whose `parent_group` slug matches the given
 * slug. Returns `{ label, accounts }` where `label` is the display
 * form taken from the first matching row (preserves original casing
 * the user typed) and `accounts` is the ordered list of rows.
 *
 * Returns `null` when no accounts match.
 */
export async function findGroupMembers(env, slug) {
  const rows = await all(
    env.DB,
    `SELECT id, name, alias, parent_group, segment, phone, website
       FROM accounts
      WHERE parent_group IS NOT NULL
      ORDER BY name`
  );
  const matches = rows.filter((r) => slugifyGroup(r.parent_group) === slug);
  if (matches.length === 0) return null;
  return {
    label: matches[0].parent_group,
    accounts: matches,
  };
}

/**
 * Every distinct parent_group label in the DB, for dropdown /
 * autocomplete use later. Returns an array of strings, sorted
 * case-insensitively.
 */
export async function listGroupLabels(env) {
  const rows = await all(
    env.DB,
    `SELECT DISTINCT parent_group FROM accounts
      WHERE parent_group IS NOT NULL AND parent_group <> ''
      ORDER BY LOWER(parent_group)`
  );
  return rows.map((r) => r.parent_group);
}

/**
 * Shape a `SELECT id, name, alias, parent_group ...` row list into the
 * `{ value, label, group }` shape used by the account-picker client
 * script (js/account-picker.js). Alias, when present, is appended in
 * parentheses so it shows up in the picker's flat mode. `group` is
 * null when the account has no parent_group label; the client treats
 * those as "Ungrouped".
 */
export function buildAccountPickerItems(accounts) {
  return (accounts || []).map((a) => ({
    value: a.id,
    label: a.alias ? `${a.name} (${a.alias})` : a.name,
    group: a.parent_group || null,
  }));
}

/**
 * Given an account, load every OTHER account in the same parent_group
 * (minimum fields for the "Siblings in group" strip on the account
 * detail page). Returns `[]` when the account has no group or is the
 * only member.
 */
export async function loadSiblingAccounts(env, accountId, parentGroup) {
  if (!parentGroup) return [];
  return all(
    env.DB,
    `SELECT id, name, alias FROM accounts
      WHERE parent_group = ?
        AND id <> ?
      ORDER BY name`,
    [parentGroup, accountId]
  );
}
