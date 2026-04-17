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
 *
 * When `prefs.show_alias` is on, the label is just the alias (since
 * every account is guaranteed to have one); otherwise it falls back
 * to the legacy "Name (alias)" format.
 */
export function buildAccountPickerItems(accounts, prefs = {}) {
  const showAlias = !!prefs.show_alias;
  return (accounts || []).map((a) => ({
    value: a.id,
    label: showAlias
      ? (a.alias || a.name)
      : (a.alias ? `${a.name} (${a.alias})` : a.name),
    group: a.parent_group || null,
  }));
}

/**
 * Returns the string to render when displaying an account's name,
 * respecting the per-user `show_alias` preference. Every account is
 * guaranteed (via app-layer enforcement and migration 0034) to have
 * a non-empty alias, but we fall back to name defensively.
 */
export function displayAccountName(account, prefs = {}) {
  if (!account) return '';
  if (prefs.show_alias) return account.alias || account.name || '';
  return account.name || account.alias || '';
}

/**
 * Returns `{ label, href }` for the "Account" cell on entity lists
 * (opportunities, quotes, jobs, activities, board), respecting both
 * per-user prefs:
 *
 *   - When `group_rollup` is on AND the account belongs to a group,
 *     the cell shows the group label and links to the group view.
 *   - Otherwise, the cell shows the displayAccountName and links to
 *     the per-account detail page.
 *
 * Pass a plain object with `id`, `name`, `alias`, `parent_group` keys
 * — typically the joined fields on a row.
 */
export function displayAccountForGroupMode(account, prefs = {}) {
  if (!account || !account.id) {
    return { label: '', href: '' };
  }
  if (prefs.group_rollup && account.parent_group) {
    return {
      label: account.parent_group,
      href: `/accounts/group/${slugifyGroup(account.parent_group)}`,
    };
  }
  return {
    label: displayAccountName(account, prefs),
    href: `/accounts/${account.id}`,
  };
}

/**
 * Shape a list of distinct parent_group labels into the `{ slug, label,
 * member_ids }` payload used by the two-stage account picker (when the
 * `group_rollup` pref is on). The picker shows groups + ungrouped
 * accounts in the primary list; selecting a group then drills into a
 * member-pick step.
 *
 * Accepts the same `accounts` array as `buildAccountPickerItems` —
 * groups are derived by partitioning on `parent_group`.
 */
export function buildAccountPickerGroups(accounts) {
  const byGroup = new Map();
  for (const a of accounts || []) {
    const g = (a.parent_group || '').trim();
    if (!g) continue;
    if (!byGroup.has(g)) byGroup.set(g, { slug: slugifyGroup(g), label: g, member_ids: [] });
    byGroup.get(g).member_ids.push(a.id);
  }
  return [...byGroup.values()].sort((a, b) =>
    a.label.toLowerCase().localeCompare(b.label.toLowerCase())
  );
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
