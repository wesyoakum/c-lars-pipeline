// functions/lib/auth.js
//
// Cloudflare Access JWT handling + user upsert.
//
// Cloudflare Access sits in front of __KEEP_PipelineDOMAIN__ and injects
// a JWT into every request in the Cf-Access-Jwt-Assertion header.
// It also sets the Cf-Access-Authenticated-User-Email header, which
// is the easy path and what we rely on here. The JWT is present as a
// secondary signal and could be verified via the team's JWKS if we
// later want stricter validation, but for P0 we trust the header
// because Access *is* the front door.
//
// Local dev fallback: when PIPELINE_ENV !== 'production' and no Access
// header is present, we inject a stub dev user (wes.yoakum@c-lars.com,
// role='admin'). This lets `wrangler pages dev` work without Access.

import { one, run } from './db.js';
import { uuid, now } from './ids.js';

const DEV_USER_EMAIL = 'wes.yoakum@c-lars.com';
const DEV_USER_NAME = 'Wes Yoakum';

/**
 * Resolve the current user for a Pages Functions request context.
 *
 * Strategy:
 *   1. Read Cf-Access-Authenticated-User-Email header.
 *   2. If present, upsert a users row keyed on email and return it.
 *   3. If absent and env.PIPELINE_ENV !== 'production', fall back to dev stub.
 *   4. Otherwise return null (middleware will 401).
 *
 * @param {Request} request
 * @param {any}     env  Pages Functions env bindings (has env.DB)
 * @returns {Promise<{id,email,display_name,role,active}|null>}
 */
export async function resolveUser(request, env) {
  const headerEmail = request.headers
    .get('cf-access-authenticated-user-email')
    ?.trim()
    ?.toLowerCase();

  const isProd = env.PIPELINE_ENV === 'production';

  let email = headerEmail;
  let displayName = null;

  if (!email) {
    if (isProd) {
      return null;
    }
    // Dev fallback
    email = DEV_USER_EMAIL;
    displayName = DEV_USER_NAME;
  }

  return upsertUser(env.DB, email, displayName);
}

/**
 * Insert or update a user by email. Returns the current row.
 * The `role` on existing rows is preserved (so the seeded admin
 * doesn't get demoted to 'sales' on first real login).
 */
export async function upsertUser(db, email, displayName) {
  const existing = await one(db, 'SELECT * FROM users WHERE email = ?', [email]);

  if (existing) {
    // Update display_name / touch updated_at without clobbering role.
    if (displayName && displayName !== existing.display_name) {
      await run(
        db,
        'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
        [displayName, now(), existing.id]
      );
      existing.display_name = displayName;
    }
    return existing;
  }

  // Infer a display name from the email local-part if none given.
  const inferred = displayName ?? emailToName(email);

  // Seed new users with the admin-blessed defaults from site_prefs
  // (migrations 0036 + 0039). If the row isn't there yet (fresh DB,
  // unmigrated environment) fall back to the per-column DEFAULT 0
  // behavior. list_table_defaults is a JSON blob keyed by list-table
  // storageKey; see migration 0039.
  const defaults = (await one(
    db,
    'SELECT show_alias, group_rollup, active_only, list_table_defaults FROM site_prefs WHERE id = 1'
  )) || { show_alias: 0, group_rollup: 0, active_only: 0, list_table_defaults: null };

  const id = uuid();
  const ts = now();
  await run(
    db,
    `INSERT INTO users (
       id, email, display_name, role, active,
       show_alias, group_rollup, active_only, list_table_prefs,
       created_at, updated_at
     )
     VALUES (?, ?, ?, 'sales', 1, ?, ?, ?, ?, ?, ?)`,
    [
      id, email, inferred,
      defaults.show_alias ? 1 : 0,
      defaults.group_rollup ? 1 : 0,
      defaults.active_only ? 1 : 0,
      defaults.list_table_defaults ?? null,
      ts, ts,
    ]
  );

  return {
    id,
    email,
    display_name: inferred,
    role: 'sales',
    active: 1,
    show_alias: defaults.show_alias ? 1 : 0,
    group_rollup: defaults.group_rollup ? 1 : 0,
    active_only: defaults.active_only ? 1 : 0,
    list_table_prefs: defaults.list_table_defaults ?? null,
    created_at: ts,
    updated_at: ts,
  };
}

function emailToName(email) {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ')
    .trim();
}

/**
 * Require a given role (or better). Admin > sales > viewer, service is sideways.
 * Returns true if allowed.
 */
export function hasRole(user, minRole) {
  if (!user) return false;
  const rank = { viewer: 1, sales: 2, admin: 3 };
  if (minRole === 'service') return user.role === 'service' || user.role === 'admin';
  return (rank[user.role] ?? 0) >= (rank[minRole] ?? 0);
}
