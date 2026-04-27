#!/usr/bin/env node
//
// scripts/wfm-import.mjs
//
// Bulk importer for WorkflowMax (WFM) exports into the C-LARS Pipeline D1.
// Invoked via the `import:wfm:dry` / `import:wfm:commit` npm scripts.
//
// Usage:
//   node scripts/wfm-import.mjs --entity accounts --file "path/to/WFM_Accounts.xlsx" --dry-run
//   node scripts/wfm-import.mjs --entity accounts --file "..." --commit --local
//   node scripts/wfm-import.mjs --entity accounts --file "..." --commit --remote
//
// Design notes:
//   - Reads the xlsx via the `xlsx` package (already a project dep).
//   - Builds a single SQL file at scripts/out/wfm-<entity>-import.sql.
//     Each INSERT gets its own statement; a preview CSV gets written
//     alongside it so the runner can spot-check before committing.
//   - For --commit, we shell out to `npx wrangler d1 execute` pointed at
//     that SQL file. This keeps the importer decoupled from the wrangler
//     API surface and reuses the same code path a human would type.
//   - Idempotency is handled by the partial unique index on
//     (external_source, external_id) — we set both so a re-run raises
//     a constraint error instead of silently double-inserting. `external_id`
//     is a name-derived slug so it's stable across re-runs of the same
//     source file.
//   - Supports entities: `accounts`, `contacts`, `opportunities`. Adding
//     quotes is a matter of adding another `buildXxxStatements()` function
//     and a case to the switch below.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// xlsx is a CommonJS module. ESM namespace imports don't expose its
// top-level helpers (readFile / utils) directly, so we grab it via the
// default export and destructure.
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg;

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(SCRIPT_DIR, 'out');

// Mirrors the admin user on the remote DB. If you run this importer
// from another workstation, update or parameterize this.
const IMPORT_USER_ID = 'user-wes-yoakum';

// Every imported row carries this marker + a slug-based external_id so
// the partial unique index on accounts(external_source, external_id)
// prevents accidental double-inserts.
const EXTERNAL_SOURCE = 'wfm';

// ---------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    entity: null,
    file: null,
    dryRun: false,
    commit: false,
    local: false,
    remote: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entity') args.entity = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--commit') args.commit = true;
    else if (a === '--local') args.local = true;
    else if (a === '--remote') args.remote = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
scripts/wfm-import.mjs — WFM → Pipeline importer

  --entity <name>   One of: accounts, contacts, opportunities, quotes
  --file <path>     Path to the WFM .xlsx export
  --dry-run         Parse + build SQL + preview CSV, do not touch the DB
  --commit          Actually execute the generated SQL via wrangler
  --local           Target the local D1 (wrangler --local)
  --remote          Target the remote D1 (wrangler --remote)

  Exactly one of --dry-run / --commit is required.
  --commit requires exactly one of --local / --remote.
`);
}

// ---------------------------------------------------------------------
// Helpers: ids, timestamps, slugs, escaping
// ---------------------------------------------------------------------

function uuid() {
  return crypto.randomUUID();
}

function now() {
  // Same ISO-8601 shape as functions/lib/ids.js::now()
  return new Date().toISOString().replace('Z', 'Z');
}

/**
 * Build a stable external_id from an account name. Must be deterministic
 * for re-run safety. We lowercase, strip everything non-alphanumeric,
 * and collapse separators to single dashes.
 */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

/**
 * SQLite literal escaping for inline SQL generation. We use inline
 * literals (not prepared statements) because wrangler d1 execute --file
 * consumes a plain SQL script.
 */
function sqlLit(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  // Treat everything else as text
  const s = String(val).replace(/'/g, "''");
  return `'${s}'`;
}

/**
 * Minimal CSV field escaper for the preview file.
 */
function csvField(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8');
}

// ---------------------------------------------------------------------
// XLSX reader
// ---------------------------------------------------------------------

function readXlsxRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // defval: '' so empty cells become '' (not undefined); raw: false
  // so Excel stores like "(713) 966-6719" come through as the string
  // the user expects instead of being interpreted as a phone number.
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// ---------------------------------------------------------------------
// Entity: accounts
// ---------------------------------------------------------------------

/**
 * Build the SQL + preview rows for the accounts import.
 *
 * Column semantics (matches the plan file and functions/accounts/index.js):
 *   - id:                   fresh UUID v4 per row
 *   - name:                 WFM `Name`, trimmed
 *   - segment:              NULL (user categorizes later via inline edit)
 *   - address_billing:      WFM `Default Address`, trimmed (legacy
 *                           denormalized column)
 *   - address_physical:     NULL
 *   - phone:                WFM `Phone`, verbatim, no cleanup
 *   - website / notes:      NULL
 *   - owner_user_id:        IMPORT_USER_ID (admin runner)
 *   - external_source:      'wfm' (idempotency safety net)
 *   - external_id:          slugify(name)
 *   - created_at/updated_at: now()
 *   - created_by_user_id:   IMPORT_USER_ID
 *
 * For each row with a populated Default Address we also insert one row
 * into account_addresses (kind='billing', label='Billing', is_default=1)
 * so the new normalized-addresses UI sees it.
 *
 * For each row we also write an audit_events row with event_type='created'
 * so the account's history tab shows the import origin.
 */
function buildAccountsStatements(rows) {
  const ts = now();
  const sqlStatements = [];
  const previewRows = [];
  const summaryRows = [];

  for (const row of rows) {
    const rawName = (row['Name'] ?? '').toString().trim();
    if (!rawName) continue; // skip blank names (shouldn't happen in WFM export)

    const rawPhone = (row['Phone'] ?? '').toString().trim() || null;
    const rawAddress = (row['Default Address'] ?? '').toString().trim() || null;
    // Status and Primary Contact are intentionally ignored per the plan.

    const id = uuid();
    const slug = slugify(rawName);

    // 1. accounts row. Alias defaults to the legal name so the per-user
    // "Show aliases" toggle (added in migration 0034) never shows blank
    // cells. Users can edit it later inline on the accounts list.
    sqlStatements.push(
      [
        `INSERT INTO accounts`,
        `  (id, name, alias, segment, address_billing, address_physical,`,
        `   phone, website, notes, owner_user_id,`,
        `   external_source, external_id,`,
        `   created_at, updated_at, created_by_user_id)`,
        `VALUES (`,
        `  ${sqlLit(id)}, ${sqlLit(rawName)}, ${sqlLit(rawName)}, NULL, ${sqlLit(rawAddress)}, NULL,`,
        `  ${sqlLit(rawPhone)}, NULL, NULL, ${sqlLit(IMPORT_USER_ID)},`,
        `  ${sqlLit(EXTERNAL_SOURCE)}, ${sqlLit(slug)},`,
        `  ${sqlLit(ts)}, ${sqlLit(ts)}, ${sqlLit(IMPORT_USER_ID)}`,
        `);`,
      ].join('\n')
    );

    // 2. account_addresses row (only if an address is present)
    let addressId = null;
    if (rawAddress) {
      addressId = uuid();
      sqlStatements.push(
        [
          `INSERT INTO account_addresses`,
          `  (id, account_id, kind, label, address, is_default, notes,`,
          `   created_at, updated_at, created_by_user_id)`,
          `VALUES (`,
          `  ${sqlLit(addressId)}, ${sqlLit(id)}, 'billing', 'Billing', ${sqlLit(rawAddress)},`,
          `  1, NULL, ${sqlLit(ts)}, ${sqlLit(ts)}, ${sqlLit(IMPORT_USER_ID)}`,
          `);`,
        ].join('\n')
      );
    }

    // 3. audit event
    const auditId = uuid();
    const changesJson = JSON.stringify({
      name: rawName,
      phone: rawPhone,
      address_billing: rawAddress,
      external_source: EXTERNAL_SOURCE,
      external_id: slug,
      import_source_file: 'WFM_Accounts.xlsx',
    });
    sqlStatements.push(
      [
        `INSERT INTO audit_events`,
        `  (id, entity_type, entity_id, event_type, user_id, at,`,
        `   summary, changes_json, override_reason)`,
        `VALUES (`,
        `  ${sqlLit(auditId)}, 'account', ${sqlLit(id)}, 'created',`,
        `  ${sqlLit(IMPORT_USER_ID)}, ${sqlLit(ts)},`,
        `  ${sqlLit(`Imported from WFM: "${rawName}"`)}, ${sqlLit(changesJson)}, NULL`,
        `);`,
      ].join('\n')
    );

    previewRows.push({
      new_account_id: id,
      name: rawName,
      external_id: slug,
      phone: rawPhone ?? '',
      address_billing: rawAddress ?? '',
      address_row_id: addressId ?? '',
    });

    summaryRows.push({
      wfm_name: rawName,
      new_account_id: id,
      external_id: slug,
      status: 'pending',
    });
  }

  return { sqlStatements, previewRows, summaryRows };
}

// ---------------------------------------------------------------------
// Entity: contacts
// ---------------------------------------------------------------------

/**
 * Load the account lookup built by the accounts phase. This is a JSON
 * array of { id, name, external_id } for every WFM-origin account in
 * the remote D1. It's captured once via the Cloudflare MCP (or
 * wrangler-powered export) after the accounts import commits.
 */
function loadAccountLookup() {
  const file = path.join(OUT_DIR, 'wfm-accounts-lookup.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing account lookup: ${file}\n` +
      `Import accounts first and export the lookup from D1 with:\n` +
      `  SELECT id, name, external_id FROM accounts\n` +
      `  WHERE external_source='wfm' ORDER BY name;`
    );
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byExternalId = new Map();
  for (const row of data) {
    if (row.external_id) byExternalId.set(row.external_id, row);
  }
  return byExternalId;
}

/**
 * Maps for the WFM contacts export's quirks. The export truncates long
 * client names (e.g. "Govt of Canada, Defence..." instead of the full
 * name) — these map the truncated form to the full Pipeline account name so
 * slugify() lands on the right external_id.
 *
 * Keys are the raw WFM Client(s) string (verbatim). Values are the full
 * account name that was actually imported in the accounts phase.
 */
const CONTACT_CLIENT_ALIASES = {
  // Truncated-in-WFM client names
  'Govt of Canada, Defence...': 'Govt of Canada, Defence and Marine Procurement Branch',
  'Helix Robotics Solutions In...': 'Helix Robotics Solutions International Corp.',
  'Naval Oceanographic Offi...': 'Naval Oceanographic Office',
  'Lincoln Electric Cutting Sy...': 'Lincoln Electric Cutting Systems',
  'International Submarine E...': 'International Submarine Engineering',
  'UCSD - University of Calif...': 'UCSD - University of California San Diego',
  'Woods Hole Oceanograph...': 'Woods Hole Oceanographic Institution WHOI',
  'University Of Hawaii Marin...': 'University Of Hawaii Marine Center',
  'Marine Ventures Internatio...': 'Marine Ventures International, Inc.',
  'Okeanus Science & Techn...': 'Okeanus Science & Technology, LLC',
  'Canpac Marine Services, I...': 'Canpac Marine Services, Inc',
  'KDDI Cableships & Subse...': 'KDDI Cableships & Subsea Engineering, Inc.',
};

/**
 * Accounts whose contact gets flagged is_primary=1 (WFM's
 * "Primary Contact" field, carried over from the accounts export).
 * Keyed by contact full-name + account full-name (conjunction so the
 * wrong Mike Smith / etc. never gets the flag by accident).
 */
const CONTACT_PRIMARY_WHITELIST = new Set([
  'Mike Thomson::Saab',
  'Naosuke Yamada::SeaBreath Co., Ltd',
  'Chris David::TGS',
]);

/**
 * Duplicate-resolution directives. Each key is the WFM contact name; the
 * value lists Client(s) values that should be DROPPED (not imported).
 * The remaining row wins. See the plan doc for why each choice — rule of
 * thumb: keep the row with phone/email filled, drop the empty one.
 *
 * "Korrie Lansford" (with the typo) is folded into "Korrie Langsford" by
 * the name-normalization step below, then the two Langsford rows with
 * blank client/email are dropped in favor of the Lansford-typo row
 * (which carries the email), reassigned to C-Innovation 2, LLC.
 */
const CONTACT_DROP_RULES = {
  'Cassandra Chia':  new Set(['Helix Robotics Solutions']),      // keep the "Helix Robotics Solutions In..." row (has phone+email)
  'Heather Tote':    new Set(['C-Innovation LLC']),               // keep C-Innovation 2, LLC (has phone+email)
  'Korrie Langsford':new Set(['C-Innovation LLC', 'C-Innovation 5, LLC']), // fold Lansford typo into C-Innovation 2, LLC below
  'Mike Smith':      new Set(['ROVOP Inc']),                      // both empty; plan picks ROVOP, Ltd
  'Stuart Campbell': new Set(['ROVOP Inc']),                      // keep ROVOP, Ltd (has email)
  'Summer Crowell':  new Set(['C-Innovation LLC']),               // keep C-Innovation 2, LLC (dup email)
};

/**
 * Split a full name into (first_name, last_name). Single-word → first
 * only. Multi-word → first word = first_name, rest = last_name. This
 * naturally keeps particles like "Van Eck" attached to the last name.
 */
function splitName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Normalize a client-name string so aliases + trailing-period cases land
 * on the same account the accounts importer created. Applies: trim,
 * alias lookup, trailing-period strip (e.g. "CIC Ltd." → "CIC Ltd" so
 * the slug matches the sanitized account name).
 */
function normalizeContactClient(raw) {
  const trimmed = (raw ?? '').toString().trim();
  if (!trimmed) return '';
  if (CONTACT_CLIENT_ALIASES[trimmed]) return CONTACT_CLIENT_ALIASES[trimmed];
  // Only strip a single trailing period; "Inc." and "Ltd." are the common
  // cases, and the accounts importer dropped them via slugify()'s
  // non-alphanumeric collapse.
  return trimmed.replace(/\.+$/, '');
}

/**
 * Build the SQL + preview rows for the contacts import.
 *
 * Column semantics (matches migrations/0001_initial.sql contacts schema):
 *   - id:                    fresh UUID v4 per row
 *   - account_id:            resolved via slugify(normalized-client) → lookup
 *   - first_name / last_name split from WFM `Name`
 *   - title / mobile:        NULL (WFM export has no columns for these)
 *   - email:                 WFM `Email`, verbatim (may include mixed case)
 *   - phone:                 WFM `Phone`, verbatim (no normalization)
 *   - is_primary:            1 for the 3 whitelisted contacts, 0 otherwise
 *   - notes:                 NULL
 *   - external_source:       'wfm'
 *   - external_id:           '<account-slug>::<name-slug>' (two-part so
 *                            the same person at two companies is distinct
 *                            under the partial unique index)
 *   - created_at/updated_at: now()
 *   - created_by_user_id:    IMPORT_USER_ID
 *
 * Also writes one audit_events row per contact (event_type='created')
 * so the account's history tab shows the import origin.
 */
function buildContactsStatements(rows, accountLookup) {
  const ts = now();
  const sqlStatements = [];
  const previewRows = [];
  const summaryRows = [];

  // Track which (dedup-key) combos we've already emitted so we don't
  // double-insert within a single run.
  const emittedKeys = new Set();

  let skippedBlank = 0;
  let skippedDup = 0;
  let skippedNoAccount = 0;

  for (const rawRow of rows) {
    let name = (rawRow['Name'] ?? '').toString().trim();
    let clientRaw = (rawRow['Client(s)'] ?? '').toString().trim();
    const email = (rawRow['Email'] ?? '').toString().trim() || null;
    const phone = (rawRow['Phone'] ?? '').toString().trim() || null;

    // Skip the TECHNICAL MANAGER placeholder and any blank-client rows.
    if (!name || !clientRaw) {
      skippedBlank++;
      continue;
    }

    // Fold the "Korrie Lansford" typo into "Korrie Langsford" AND
    // retarget it to the C-Innovation 2, LLC row that carries the email.
    // This is the only row where we rewrite the client mid-flight.
    if (name === 'Korrie Lansford') {
      name = 'Korrie Langsford';
      clientRaw = 'C-Innovation 2, LLC';
    }

    // Apply the drop rules.
    if (CONTACT_DROP_RULES[name] && CONTACT_DROP_RULES[name].has(clientRaw)) {
      skippedDup++;
      continue;
    }

    // Resolve account.
    const clientName = normalizeContactClient(clientRaw);
    const slug = slugify(clientName);
    const account = accountLookup.get(slug);
    if (!account) {
      console.warn(
        `  ! no account for contact "${name}" / client "${clientRaw}" (slug="${slug}") — skipped`
      );
      skippedNoAccount++;
      continue;
    }

    // Dedup safety net (paranoia, in case the rules above miss an edge).
    const dedupKey = `${account.id}::${name.toLowerCase()}`;
    if (emittedKeys.has(dedupKey)) {
      skippedDup++;
      continue;
    }
    emittedKeys.add(dedupKey);

    const { first, last } = splitName(name);
    const id = uuid();
    const isPrimary = CONTACT_PRIMARY_WHITELIST.has(`${name}::${account.name}`) ? 1 : 0;
    const extId = `${account.external_id}::${slugify(name)}`;

    // contacts row
    sqlStatements.push(
      [
        `INSERT INTO contacts`,
        `  (id, account_id, first_name, last_name, title, email, phone, mobile,`,
        `   is_primary, notes, external_source, external_id,`,
        `   created_at, updated_at, created_by_user_id)`,
        `VALUES (`,
        `  ${sqlLit(id)}, ${sqlLit(account.id)}, ${sqlLit(first)}, ${sqlLit(last)}, NULL,`,
        `  ${sqlLit(email)}, ${sqlLit(phone)}, NULL,`,
        `  ${isPrimary}, NULL, ${sqlLit(EXTERNAL_SOURCE)}, ${sqlLit(extId)},`,
        `  ${sqlLit(ts)}, ${sqlLit(ts)}, ${sqlLit(IMPORT_USER_ID)}`,
        `);`,
      ].join('\n')
    );

    // audit event on the contact (entity_type='contact' so it shows on the
    // contact's history; the existing account-level audit rows from the
    // accounts phase already cover the "imported from WFM" story for the
    // parent account).
    const auditId = uuid();
    const changesJson = JSON.stringify({
      account_id: account.id,
      account_name: account.name,
      name,
      email,
      phone,
      is_primary: isPrimary,
      external_source: EXTERNAL_SOURCE,
      external_id: extId,
      import_source_file: 'WFM_Contacts.xlsx',
    });
    sqlStatements.push(
      [
        `INSERT INTO audit_events`,
        `  (id, entity_type, entity_id, event_type, user_id, at,`,
        `   summary, changes_json, override_reason)`,
        `VALUES (`,
        `  ${sqlLit(auditId)}, 'contact', ${sqlLit(id)}, 'created',`,
        `  ${sqlLit(IMPORT_USER_ID)}, ${sqlLit(ts)},`,
        `  ${sqlLit(`Imported from WFM: "${name}" @ ${account.name}`)}, ${sqlLit(changesJson)}, NULL`,
        `);`,
      ].join('\n')
    );

    previewRows.push({
      new_contact_id: id,
      account_id: account.id,
      account_name: account.name,
      name,
      first_name: first ?? '',
      last_name: last ?? '',
      email: email ?? '',
      phone: phone ?? '',
      is_primary: isPrimary,
      external_id: extId,
    });

    summaryRows.push({
      wfm_name: name,
      wfm_client: clientRaw,
      account_id: account.id,
      new_contact_id: id,
      is_primary: isPrimary,
      external_id: extId,
      status: 'pending',
    });
  }

  console.log(`  Skipped ${skippedBlank} blank-name/client rows.`);
  console.log(`  Skipped ${skippedDup} duplicate rows (dedup rules).`);
  if (skippedNoAccount > 0) {
    console.log(`  Skipped ${skippedNoAccount} rows with no matching account.`);
  }

  return { sqlStatements, previewRows, summaryRows };
}

// ---------------------------------------------------------------------
// Entity: opportunities
// ---------------------------------------------------------------------

/**
 * Load the contact lookup built by the contacts phase. JSON array of
 * { id, account_id, first_name, last_name } for every WFM-origin
 * contact in the remote D1. Exported via MCP after the contacts import.
 */
function loadContactLookup() {
  const file = path.join(OUT_DIR, 'wfm-contacts-lookup.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing contact lookup: ${file}\n` +
      `Import contacts first and export the lookup from D1 with:\n` +
      `  SELECT id, account_id, first_name, last_name FROM contacts\n` +
      `  WHERE external_source='wfm';`
    );
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Key: `${account_id}::${lower(first last)}`
  const byAcctAndName = new Map();
  for (const row of data) {
    const fullName = [row.first_name, row.last_name]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();
    if (!fullName) continue;
    byAcctAndName.set(`${row.account_id}::${fullName}`, row);
  }
  return byAcctAndName;
}

/**
 * WFM Leads export quirks: the Account column is sometimes a slightly
 * different name than the one the accounts importer loaded, or an
 * outright different account. These remaps run BEFORE slug matching.
 *
 *   - 'iSOC' is a misread of 'WASSOC'; 2 rows remapped.
 *   - Excel truncated "Govt of Canada, Defence and Marine Procurement
 *     Branch" with a trailing ellipsis; handled below.
 */
const OPP_ACCOUNT_NAME_REMAP = {
  'iSOC': 'WASSOC',
};

/**
 * Strip the Excel-truncation ellipsis and, if that leaves a prefix,
 * try to match any Pipeline account whose name starts with that prefix.
 * Returns the full name if resolved, else the input unchanged.
 */
function resolveTruncatedAccountName(raw, accountLookupByName) {
  const trimmed = raw.trim();
  if (!/\.{2,}$/.test(trimmed)) return trimmed;
  const stem = trimmed.replace(/\.{2,}$/, '').trim();
  if (!stem) return trimmed;
  for (const fullName of accountLookupByName.keys()) {
    if (fullName.startsWith(stem)) return fullName;
  }
  return trimmed;
}

/**
 * WFM owners → Pipeline user IDs. Only Wes has a real login; the other three
 * were seeded as stubs (role='sales', active=1) specifically so the
 * import preserves attribution. Null (1 lead) defaults to Wes as the
 * importing admin.
 */
const OPP_OWNER_TO_USER_ID = {
  'Wes Yoakum':       'user-wes-yoakum',
  'Kat Deno':         'user-kat-deno',
  'Sara Patterson':   'user-sara-patterson',
  'Adam Janac':       'user-adam-janac',
};

/**
 * (WFM Stage, WFM Status) → Pipeline stage key.
 *
 * Status takes priority when Won/Lost: every Won maps to closed_won and
 * every Lost maps to closed_lost, EXCEPT the single Won + "6 Incomplete"
 * row which maps to closed_died (per user direction — the deal closed
 * without ever being fully spec'd so "won" isn't really true).
 *
 * close_reason is intentionally NOT populated — the stage column alone
 * carries the close state. The column stays NULL for all 196 rows.
 */
function mapStage(wfmStage, wfmStatus) {
  const status = (wfmStatus || '').trim();
  const stage = (wfmStage || '').trim();

  if (status === 'Won') {
    return stage === '6 Incomplete' ? 'closed_died' : 'closed_won';
  }
  if (status === 'Lost') return 'closed_lost';

  // Active (or anything else — fall through to stage-based mapping)
  switch (stage) {
    case 'Spares Quoted':
    case '4 Quoted':
      return 'quote_submitted';
    case 'Spares RFQ':
    case '3 Opportunity':
      return 'rfq_received';
    case '5 Negotiation':
      return 'quote_under_revision';
    case '2 Lead':
    case '1 Prospect':
    case 'Uncategorized':
    default:
      return 'lead';
  }
}

/**
 * Transaction type: Spares for any WFM stage starting with "Spares"
 * (Spares RFQ, Spares Quoted — 108 rows). Everything else → EPS
 * (Engineered Products & Services — the highest-value class; user
 * will re-tag any that should be refurb/service manually afterward).
 */
function mapTransactionType(wfmStage) {
  const s = (wfmStage || '').trim();
  return /^Spares\b/i.test(s) ? 'spares' : 'eps';
}

/**
 * stage_definitions default_probability mirror. Kept in sync via a query
 * on the live DB at planning time; safer than a runtime fetch because
 * this runs offline. All 4 transaction_type variants share identical
 * default_probability values for each stage_key, so a single map works.
 */
const STAGE_DEFAULT_PROBABILITY = {
  lead: 5,
  rfq_received: 10,
  awaiting_client_feedback: 20,
  quote_drafted: 40,
  quote_submitted: 60,
  quote_under_revision: 65,
  revised_quote_submitted: 75,
  closed_won: 95,
  oc_issued: 97,
  ntp_draft: 98,
  ntp_issued: 100,
  closed_lost: 0,
  closed_died: 0,
};

/**
 * Excel serial (1900 date system) → ISO 'YYYY-MM-DD'. Matches how the
 * xlsx package exposes raw date serials when `raw: true` is set.
 */
function excelSerialToIso(serial) {
  if (serial == null || serial === '') return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  // 1900 date system epoch is Dec 30 1899 (accounts for the leap-year bug)
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * XLSX is read with `raw: false`, which means Excel date cells come through
 * as formatted strings (e.g. "4/3/2026") instead of serials. Numeric values
 * (pure integer serials) also get stringified — "46027". Accept either and
 * produce { serial, iso } so callers can sort chronologically (via serial)
 * and emit ISO dates for storage.
 */
function coerceWfmDate(rawDate) {
  if (rawDate == null || rawDate === '') return { serial: null, iso: null };
  // Pure numeric serial path.
  const asStr = String(rawDate).trim();
  if (/^-?\d+(\.\d+)?$/.test(asStr)) {
    const n = Number(asStr);
    return { serial: n, iso: excelSerialToIso(n) };
  }
  // Date-string path ("4/3/2026", "2026-04-03", etc.). We parse via Date
  // constructor and convert back to a synthesized serial for ordering.
  const parsed = new Date(asStr);
  if (Number.isNaN(parsed.getTime())) return { serial: null, iso: null };
  const iso = parsed.toISOString().slice(0, 10);
  const serial = Math.floor((parsed.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  return { serial, iso };
}

/**
 * Build the SQL + preview rows for the opportunities import.
 *
 * Column semantics (matches the opportunities schema as of migration 0028):
 *   - id:                    fresh UUID v4
 *   - number:                'WFM01-NNNN' (chronological by WFM Date,
 *                            oldest = 0001; easy to spot-as-imported
 *                            and easy to rename later)
 *   - account_id:            slug-match to accounts.external_id
 *   - primary_contact_id:    lookup by (account_id, lower(first last)),
 *                            NULL on no match
 *   - title:                 WFM Name, verbatim trim
 *   - description:           NULL (Hot Sheet intentionally dropped)
 *   - transaction_type:      mapTransactionType()
 *   - stage:                 mapStage()
 *   - stage_entered_at:      WFM Date (ISO)
 *   - probability:           STAGE_DEFAULT_PROBABILITY[stage]
 *   - estimated_value_usd:   WFM Est. Value (zeros → NULL: "not estimated")
 *   - currency:              'USD'
 *   - expected_close_date:   WFM Date (Active only)
 *   - actual_close_date:     WFM Date (Won/Lost/died only)
 *   - close_reason:          NULL (stage carries the close state)
 *   - source / rfq_format / all BANT / loss_reason_tag: NULL
 *   - owner_user_id:         OPP_OWNER_TO_USER_ID[Owner]
 *   - salesperson_user_id:   same as owner
 *   - external_source:       'wfm'
 *   - external_id:           '<account-slug>::<title-slug>::<date-serial>'
 *                            (three-part: 7 duplicate Names exist — need
 *                            date to disambiguate)
 *   - created_at:            WFM Date (user direction — use WFM Date, not
 *                            now(), so the pipeline history looks right)
 *   - updated_at:            now()
 *   - created_by_user_id:    IMPORT_USER_ID
 *   - All the later migration columns (rfq_received_date, rfq_due_date,
 *     rfi_due_date, quoted_date, customer_po_number, bant_authority_contact_id):
 *     NULL.
 *
 * Also writes an audit_events row per opportunity with event_type='created'.
 */
function buildOpportunitiesStatements(rows, accountLookup, contactLookup) {
  const ts = now();
  const sqlStatements = [];
  const previewRows = [];
  const summaryRows = [];

  // Also index accounts by full name for truncation-recovery.
  const accountLookupByName = new Map();
  for (const acct of accountLookup.values()) {
    accountLookupByName.set(acct.name, acct);
  }

  let skippedNoAccount = 0;

  // Precompute per-row resolution so we can sort by date BEFORE numbering.
  const resolved = [];
  for (const rawRow of rows) {
    const title = (rawRow['Name'] ?? '').toString().trim();
    if (!title) continue;

    // Account resolution: iSOC→WASSOC remap, then truncation recovery,
    // then slug match.
    let rawAccount = (rawRow['Account'] ?? '').toString().trim();
    if (OPP_ACCOUNT_NAME_REMAP[rawAccount]) {
      rawAccount = OPP_ACCOUNT_NAME_REMAP[rawAccount];
    }
    const normalizedAccount = resolveTruncatedAccountName(rawAccount, accountLookupByName);
    const accountSlug = slugify(normalizedAccount);
    const account = accountLookup.get(accountSlug);
    if (!account) {
      console.warn(`  ! no account for opp "${title}" / "${rawAccount}" (slug="${accountSlug}") — skipped`);
      skippedNoAccount++;
      continue;
    }

    const { serial: dateSerial, iso: dateIso } = coerceWfmDate(rawRow['Date']);

    const status = (rawRow['Status'] ?? '').toString().trim();
    const wfmStage = (rawRow['Stage'] ?? '').toString().trim();
    const stage = mapStage(wfmStage, status);
    const transactionType = mapTransactionType(wfmStage);
    const probability = STAGE_DEFAULT_PROBABILITY[stage] ?? null;

    // Est. Value: 0 becomes NULL ("not yet estimated" for early-stage leads).
    // XLSX raw:false returns formatted strings — "2,189,480.00" — strip the
    // thousand-separator commas before Number()-ing.
    const rawValue = rawRow['Est. Value'];
    const cleanValue = rawValue != null && rawValue !== ''
      ? Number(String(rawValue).replace(/,/g, ''))
      : NaN;
    const value = Number.isFinite(cleanValue) && cleanValue > 0 ? cleanValue : null;

    // Contact: lookup by (account_id, lower(full name))
    const contactName = (rawRow['Contact'] ?? '').toString().trim();
    let contactId = null;
    if (contactName) {
      const hit = contactLookup.get(`${account.id}::${contactName.toLowerCase()}`);
      if (hit) contactId = hit.id;
    }

    // Owner: falls back to import user if blank/unknown
    const ownerRaw = (rawRow['Owner'] ?? '').toString().trim();
    const ownerUserId = OPP_OWNER_TO_USER_ID[ownerRaw] ?? IMPORT_USER_ID;

    // Dates: created_at / stage_entered_at = WFM Date; close dates by status.
    const createdAt = dateIso ? `${dateIso}T00:00:00.000Z` : ts;
    const stageEnteredAt = createdAt;
    const isClosed = status === 'Won' || status === 'Lost';
    const expectedClose = isClosed ? null : dateIso;
    const actualClose = isClosed ? dateIso : null;

    // Hot Sheet intentionally dropped.
    resolved.push({
      id: uuid(),
      account,
      title,
      contactId,
      contactName,
      dateSerial,
      dateIso,
      wfmStage,
      status,
      stage,
      transactionType,
      probability,
      value,
      ownerUserId,
      ownerRaw,
      createdAt,
      stageEnteredAt,
      expectedClose,
      actualClose,
    });
  }

  // Chronological numbering: oldest WFM Date → WFM01-0001.
  resolved.sort((a, b) => {
    const ax = a.dateSerial ?? Infinity;
    const bx = b.dateSerial ?? Infinity;
    if (ax !== bx) return ax - bx;
    // Secondary sort by title to keep numbering deterministic for ties.
    return a.title.localeCompare(b.title);
  });

  resolved.forEach((r, idx) => {
    const number = `WFM01-${String(idx + 1).padStart(4, '0')}`;
    const extId = `${r.account.external_id}::${slugify(r.title)}::${r.dateSerial ?? 'nodate'}`;

    // opportunities row
    sqlStatements.push(
      [
        `INSERT INTO opportunities`,
        `  (id, number, account_id, primary_contact_id, title, description,`,
        `   transaction_type, stage, stage_entered_at, probability,`,
        `   estimated_value_usd, currency,`,
        `   expected_close_date, actual_close_date,`,
        `   source, rfq_format,`,
        `   bant_budget, bant_authority, bant_need, bant_timeline,`,
        `   close_reason, loss_reason_tag,`,
        `   owner_user_id, salesperson_user_id,`,
        `   external_source, external_id,`,
        `   created_at, updated_at, created_by_user_id,`,
        `   bant_authority_contact_id,`,
        `   rfq_received_date, rfq_due_date, rfi_due_date, quoted_date,`,
        `   customer_po_number)`,
        `VALUES (`,
        `  ${sqlLit(r.id)}, ${sqlLit(number)}, ${sqlLit(r.account.id)}, ${sqlLit(r.contactId)}, ${sqlLit(r.title)}, NULL,`,
        `  ${sqlLit(r.transactionType)}, ${sqlLit(r.stage)}, ${sqlLit(r.stageEnteredAt)}, ${sqlLit(r.probability)},`,
        `  ${sqlLit(r.value)}, 'USD',`,
        `  ${sqlLit(r.expectedClose)}, ${sqlLit(r.actualClose)},`,
        `  NULL, NULL,`,
        `  NULL, NULL, NULL, NULL,`,
        `  NULL, NULL,`,
        `  ${sqlLit(r.ownerUserId)}, ${sqlLit(r.ownerUserId)},`,
        `  ${sqlLit(EXTERNAL_SOURCE)}, ${sqlLit(extId)},`,
        `  ${sqlLit(r.createdAt)}, ${sqlLit(ts)}, ${sqlLit(IMPORT_USER_ID)},`,
        `  NULL,`,
        `  NULL, NULL, NULL, NULL,`,
        `  NULL`,
        `);`,
      ].join('\n')
    );

    // audit event
    const auditId = uuid();
    const changesJson = JSON.stringify({
      number,
      account_id: r.account.id,
      account_name: r.account.name,
      title: r.title,
      transaction_type: r.transactionType,
      stage: r.stage,
      wfm_stage: r.wfmStage,
      wfm_status: r.status,
      estimated_value_usd: r.value,
      wfm_owner: r.ownerRaw || null,
      owner_user_id: r.ownerUserId,
      primary_contact_id: r.contactId,
      wfm_contact: r.contactName || null,
      created_at: r.createdAt,
      external_source: EXTERNAL_SOURCE,
      external_id: extId,
      import_source_file: 'WFM_Leads.xlsx',
    });
    sqlStatements.push(
      [
        `INSERT INTO audit_events`,
        `  (id, entity_type, entity_id, event_type, user_id, at,`,
        `   summary, changes_json, override_reason)`,
        `VALUES (`,
        `  ${sqlLit(auditId)}, 'opportunity', ${sqlLit(r.id)}, 'created',`,
        `  ${sqlLit(IMPORT_USER_ID)}, ${sqlLit(ts)},`,
        `  ${sqlLit(`Imported from WFM: "${r.title}" @ ${r.account.name} (${number})`)}, ${sqlLit(changesJson)}, NULL`,
        `);`,
      ].join('\n')
    );

    previewRows.push({
      number,
      new_opp_id: r.id,
      title: r.title,
      account_name: r.account.name,
      transaction_type: r.transactionType,
      stage: r.stage,
      wfm_stage: r.wfmStage,
      wfm_status: r.status,
      estimated_value_usd: r.value ?? '',
      owner: r.ownerRaw || '',
      owner_user_id: r.ownerUserId,
      contact: r.contactName || '',
      contact_id: r.contactId || '',
      date: r.dateIso || '',
      external_id: extId,
    });

    summaryRows.push({
      number,
      new_opp_id: r.id,
      wfm_title: r.title,
      account_id: r.account.id,
      external_id: extId,
      status: 'pending',
    });
  });

  if (skippedNoAccount > 0) {
    console.log(`  Skipped ${skippedNoAccount} rows with no matching account.`);
  }

  return { sqlStatements, previewRows, summaryRows };
}

// ---------------------------------------------------------------------
// Entity: quotes
// ---------------------------------------------------------------------

/**
 * Load the WFM-origin opportunities lookup. Produced manually via:
 *   SELECT o.id AS opp_id, o.number AS opp_number, o.title, o.transaction_type,
 *          a.name AS account_name, a.external_id AS account_external_id
 *   FROM opportunities o
 *   JOIN accounts a ON a.id = o.account_id
 *   WHERE o.external_source='wfm'
 *   ORDER BY o.number;
 *
 * Expected rows: 196 (the WFM01-0001 … WFM01-0196 set created in phase C).
 *
 * Returned Map: key = `${account_slug}::${title_slug}`, value = array of opp
 * records (array because some titles duplicate across opps — e.g. Q25232 &
 * Q25196 both match WFM01-0101 and WFM01-0189 on "Repair Levelwind PCB
 * Board"). Callers pick the lowest-numbered opp when the array has > 1
 * entry (tiebreaker rule: oldest opp wins).
 */
function loadOppsLookup() {
  const file = path.join(OUT_DIR, 'wfm-opps-lookup.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing opps lookup: ${file}\n` +
      `Import opportunities first and export the lookup from D1 with:\n` +
      `  SELECT o.id, o.number, o.title, o.transaction_type,\n` +
      `         a.name AS account_name, a.external_id AS account_external_id\n` +
      `  FROM opportunities o JOIN accounts a ON a.id=o.account_id\n` +
      `  WHERE o.external_source='wfm' ORDER BY o.number;`
    );
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Key: `${slugify(account_name)}::${slugify(title)}`
  const byAcctAndTitle = new Map();
  for (const row of data) {
    const acctSlug = slugify(row.account_name || '');
    const titleSlug = slugify(row.title || '');
    if (!acctSlug || !titleSlug) continue;
    const key = `${acctSlug}::${titleSlug}`;
    if (!byAcctAndTitle.has(key)) byAcctAndTitle.set(key, []);
    byAcctAndTitle.get(key).push(row);
  }
  return byAcctAndTitle;
}

/**
 * WFM quotes Sales Person → Pipeline user ID.
 *
 * Fatymee Byrne (1 row) is deliberately remapped to Wes per user direction
 * (her attribution was dropped). Blank Sales Person (87 rows) also defaults
 * to Wes as the importing admin.
 */
const QUOTE_SALES_TO_USER_ID = {
  'Wes Yoakum':     'user-wes-yoakum',
  'Kat Deno':       'user-kat-deno',
  'Sara Patterson': 'user-sara-patterson',
  'Adam Janac':     'user-adam-janac',
  // 'Fatymee Byrne' intentionally NOT mapped — falls through to Wes default
};

/**
 * WFM quote status → Pipeline quote status. See migration 0011 for Pipeline statuses:
 *   draft | issued | revision_draft | revision_issued |
 *   accepted | rejected | expired | dead
 *
 * Per user direction:
 *   - Accepted → accepted
 *   - Declined → rejected
 *   - Expired  → expired
 *   - Draft    → draft
 *   - Issued   → issued
 *   - Revised  → dead (WFM's "this one was replaced by a newer revision")
 */
const QUOTE_STATUS_MAP = {
  'Accepted': 'accepted',
  'Declined': 'rejected',
  'Expired':  'expired',
  'Draft':    'draft',
  'Issued':   'issued',
  'Revised':  'dead',
};

/**
 * Derive orphan-opp transaction_type from the quote's Name. Regex-matches
 * LARS/winch/HPU/refurb/cylinder/A-frame/service/crane keywords → 'eps'
 * (Engineered Products & Services). Everything else → 'spares'.
 *
 * Note: for quotes that match an existing WFM01 opp we inherit that opp's
 * transaction_type instead; this regex only runs for new orphan opps.
 */
function deriveQuoteTxnType(title) {
  const t = String(title || '');
  return /LARS|winch|hpu|refurb|cylinder|a[-\s]?frame|service|crane/i.test(t)
    ? 'eps'
    : 'spares';
}

/**
 * Derive orphan-opp stage from the "latest" quote in a revision chain.
 * Called with the latest row's status string.
 *
 *   Accepted → closed_won
 *   Declined → closed_lost
 *   Expired  → closed_died
 *   Draft/Issued/Revised → quote_submitted
 */
function deriveOrphanOppStage(latestStatus) {
  switch ((latestStatus || '').trim()) {
    case 'Accepted': return 'closed_won';
    case 'Declined': return 'closed_lost';
    case 'Expired':  return 'closed_died';
    case 'Draft':
    case 'Issued':
    case 'Revised':
    default:
      return 'quote_submitted';
  }
}

/**
 * Parse a WFM-formatted date string ("13 Jul 2026" / "05 Jul 2026") to
 * ISO 'YYYY-MM-DD'. Returns null for blanks or unparseable values.
 */
function parseWfmQuoteDate(raw) {
  if (raw == null || raw === '') return null;
  const parsed = new Date(String(raw).trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Strip commas and parse to Number. Returns null for blanks/zeros/unparseables.
 * Used for both Amount (quote total_price) and for deciding whether an orphan
 * opp gets an estimated_value_usd (zero → NULL "not estimated").
 */
function parseWfmMoney(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Build the SQL + preview rows for the quotes import.
 *
 * Strategy:
 *   1. Normalize No. ("Q25002/1" → "Q25002-1" — one such row exists).
 *   2. Parse No. into (base, seq). seq=0 = plain base, seq=1+ from -N suffix.
 *   3. Group rows by base → 276 base groups (225 singletons, 39 pairs,
 *      9 triples, 3 quadruples per verification on WFM_Quotes.xlsx).
 *   4. For each base, attempt an EXACT slug match on (account, title) to an
 *      existing WFM01 opp from wfm-opps-lookup.json. If multiple opps match,
 *      pick the lowest-numbered (oldest) opp.
 *   5. If no match → create an orphan opp 'WFM02-<digits>' (quote base minus
 *      the leading Q). Title = quote Name; account from client lookup;
 *      transaction_type from keyword regex on title; stage from latest
 *      revision's status; estimated_value_usd from latest revision's Amount.
 *   6. Emit one quotes row per WFM row (343 total). Revision = A/B/C/D by seq.
 *      supersedes_quote_id chains within the base group (seq N points at seq
 *      N-1's id). status = QUOTE_STATUS_MAP[WFM Status]. quote_type inherited
 *      from the linked opp's transaction_type.
 *
 * Every INSERT is prefaced with an external_source='wfm' / external_id marker
 * discriminated by prefix so the rollback SQL can target exactly the rows we
 * created:
 *   - orphan opps:   external_id = 'quotes-orphan::Q25XXX'
 *   - quotes:        external_id = 'quote::Q25XXX' or 'quote::Q25XXX-N'
 */
function buildQuotesStatements(rows, accountLookup, oppsLookup) {
  const ts = now();
  const sqlStatements = [];
  const rollbackStatements = [];
  const previewRows = [];
  const summaryRows = [];

  // ---- 1 + 2: normalize, parse into (base, seq) ----
  const parsed = [];
  for (const row of rows) {
    const rawNo = String(row['No.'] ?? '').trim();
    if (!rawNo) continue;
    const normalized = rawNo.replace('/', '-');
    const m = normalized.match(/^(Q\d+)(?:-(\d+))?$/);
    if (!m) {
      console.warn(`  ! unparseable quote number "${rawNo}" — skipped`);
      continue;
    }
    const base = m[1];
    const seq = m[2] ? parseInt(m[2], 10) : 0;
    parsed.push({ base, seq, number: normalized, raw: row });
  }

  // ---- 3: group by base ----
  const groups = new Map(); // base → [{ base, seq, number, raw }, ...]
  for (const p of parsed) {
    if (!groups.has(p.base)) groups.set(p.base, []);
    groups.get(p.base).push(p);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.seq - b.seq);
  }

  // ---- 4 + 5: resolve opp per base group ----
  // Output structure: each group now has `opp` = existing WFM01 record
  // or `orphanOpp` = a freshly-synthesized record to INSERT.
  let exactMatches = 0;
  let orphanOpps = 0;
  let skippedNoAccount = 0;

  const resolvedGroups = [];
  for (const [base, group] of groups.entries()) {
    const firstRow = group[0].raw;
    const latestRow = group[group.length - 1].raw;

    const clientName = String(firstRow.Client ?? '').trim();
    const acctSlug = slugify(clientName);
    const account = accountLookup.get(acctSlug);
    if (!account) {
      console.warn(`  ! no account for quote ${base} / "${clientName}" (slug="${acctSlug}") — skipped`);
      skippedNoAccount++;
      continue;
    }

    const title = String(firstRow.Name ?? '').trim();
    const titleSlug = slugify(title);
    const key = `${acctSlug}::${titleSlug}`;
    const candidates = oppsLookup.get(key);

    let opp = null;         // { id, number, title, transaction_type } from lookup
    let orphanOpp = null;   // { id, number, title, account_id, ... } to be inserted

    if (candidates && candidates.length > 0) {
      // Tiebreaker: lowest WFM01 number (oldest opp).
      const sorted = [...candidates].sort((a, b) =>
        String(a.number).localeCompare(String(b.number))
      );
      opp = sorted[0];
      exactMatches++;
    } else {
      // Orphan: create a new WFM02 opp. Number = 'WFM02-' + quote base digits.
      const digits = base.replace(/^Q/, '');
      const number = `WFM02-${digits}`;
      const latestStatus = String(latestRow.Status ?? '').trim();
      const latestSales = String(latestRow['Sales Person'] ?? '').trim();
      const ownerUserId = QUOTE_SALES_TO_USER_ID[latestSales] ?? IMPORT_USER_ID;
      const stage = deriveOrphanOppStage(latestStatus);
      const transactionType = deriveQuoteTxnType(title);
      const probability = STAGE_DEFAULT_PROBABILITY[stage] ?? null;
      const estValue = parseWfmMoney(latestRow.Amount);

      // created_at proxy: use the earliest valid_until in the group as a
      // stand-in (WFM doesn't export quote-creation dates on this report).
      // Fall back to now() if none parseable.
      let createdAt = ts;
      for (const g of group) {
        const iso = parseWfmQuoteDate(g.raw['Valid Until']);
        if (iso) { createdAt = `${iso}T00:00:00.000Z`; break; }
      }

      const isClosed = stage === 'closed_won' || stage === 'closed_lost' || stage === 'closed_died';
      const actualCloseIso = isClosed ? parseWfmQuoteDate(latestRow['Valid Until']) : null;
      const expectedCloseIso = !isClosed ? parseWfmQuoteDate(latestRow['Valid Until']) : null;

      orphanOpp = {
        id: uuid(),
        number,
        account,
        title,
        transactionType,
        stage,
        probability,
        estValue,
        ownerUserId,
        ownerRaw: latestSales,
        createdAt,
        expectedCloseIso,
        actualCloseIso,
        externalId: `quotes-orphan::${base}`,
      };
      orphanOpps++;
    }

    resolvedGroups.push({ base, group, account, opp, orphanOpp });
  }

  // ---- 5a: emit orphan opp INSERTs (before any quote INSERT that FKs them) ----
  for (const rg of resolvedGroups) {
    if (!rg.orphanOpp) continue;
    const o = rg.orphanOpp;
    sqlStatements.push(
      [
        `INSERT INTO opportunities`,
        `  (id, number, account_id, primary_contact_id, title, description,`,
        `   transaction_type, stage, stage_entered_at, probability,`,
        `   estimated_value_usd, currency,`,
        `   expected_close_date, actual_close_date,`,
        `   source, rfq_format,`,
        `   bant_budget, bant_authority, bant_need, bant_timeline,`,
        `   close_reason, loss_reason_tag,`,
        `   owner_user_id, salesperson_user_id,`,
        `   external_source, external_id,`,
        `   created_at, updated_at, created_by_user_id,`,
        `   bant_authority_contact_id,`,
        `   rfq_received_date, rfq_due_date, rfi_due_date, quoted_date,`,
        `   customer_po_number)`,
        `VALUES (`,
        `  ${sqlLit(o.id)}, ${sqlLit(o.number)}, ${sqlLit(o.account.id)}, NULL, ${sqlLit(o.title)}, NULL,`,
        `  ${sqlLit(o.transactionType)}, ${sqlLit(o.stage)}, ${sqlLit(o.createdAt)}, ${sqlLit(o.probability)},`,
        `  ${sqlLit(o.estValue)}, 'USD',`,
        `  ${sqlLit(o.expectedCloseIso)}, ${sqlLit(o.actualCloseIso)},`,
        `  NULL, NULL,`,
        `  NULL, NULL, NULL, NULL,`,
        `  NULL, NULL,`,
        `  ${sqlLit(o.ownerUserId)}, ${sqlLit(o.ownerUserId)},`,
        `  ${sqlLit(EXTERNAL_SOURCE)}, ${sqlLit(o.externalId)},`,
        `  ${sqlLit(o.createdAt)}, ${sqlLit(ts)}, ${sqlLit(IMPORT_USER_ID)},`,
        `  NULL,`,
        `  NULL, NULL, NULL, NULL,`,
        `  NULL`,
        `);`,
      ].join('\n')
    );

    // audit event for orphan opp
    const auditId = uuid();
    const changesJson = JSON.stringify({
      number: o.number,
      account_id: o.account.id,
      account_name: o.account.name,
      title: o.title,
      transaction_type: o.transactionType,
      stage: o.stage,
      estimated_value_usd: o.estValue,
      wfm_owner: o.ownerRaw || null,
      owner_user_id: o.ownerUserId,
      created_at: o.createdAt,
      external_source: EXTERNAL_SOURCE,
      external_id: o.externalId,
      import_source_file: 'WFM_Quotes.xlsx',
      origin: 'orphan-opp-for-quote-without-matching-lead',
    });
    sqlStatements.push(
      [
        `INSERT INTO audit_events`,
        `  (id, entity_type, entity_id, event_type, user_id, at,`,
        `   summary, changes_json, override_reason)`,
        `VALUES (`,
        `  ${sqlLit(auditId)}, 'opportunity', ${sqlLit(o.id)}, 'created',`,
        `  ${sqlLit(IMPORT_USER_ID)}, ${sqlLit(ts)},`,
        `  ${sqlLit(`Imported from WFM quotes: orphan opp "${o.title}" @ ${o.account.name} (${o.number})`)}, ${sqlLit(changesJson)}, NULL`,
        `);`,
      ].join('\n')
    );
  }

  // ---- 6: emit one quote INSERT per WFM row ----
  const REVISION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  for (const rg of resolvedGroups) {
    const oppId = rg.opp ? rg.opp.id : rg.orphanOpp.id;
    const oppNumber = rg.opp ? rg.opp.number : rg.orphanOpp.number;
    const oppTxnType = rg.opp ? rg.opp.transaction_type : rg.orphanOpp.transactionType;

    // Track ids within the group so we can set supersedes_quote_id.
    const idsBySeq = new Map();

    for (const g of rg.group) {
      const r = g.raw;
      const id = uuid();
      idsBySeq.set(g.seq, id);

      const number = g.number; // already normalized
      const revisionIdx = g.seq; // 0→A, 1→B, ...
      const revision = REVISION_LETTERS[revisionIdx] ?? `R${revisionIdx}`;

      const wfmStatus = String(r.Status ?? '').trim();
      const pipelineStatus = QUOTE_STATUS_MAP[wfmStatus] ?? 'draft';

      const title = String(r.Name ?? '').trim();
      const total = parseWfmMoney(r.Amount);
      const totalVal = total ?? 0;

      const validUntilIso = parseWfmQuoteDate(r['Valid Until']);
      const quoteDueDateIso = parseWfmQuoteDate(r.QuoteDueDate);

      // created_at proxy: the quote's Valid Until, which is the only dated
      // field in the WFM export. Fall back to the group's createdAt proxy.
      const createdAt = validUntilIso
        ? `${validUntilIso}T00:00:00.000Z`
        : (rg.orphanOpp ? rg.orphanOpp.createdAt : ts);

      const sales = String(r['Sales Person'] ?? '').trim();
      const createdByUserId = QUOTE_SALES_TO_USER_ID[sales] ?? IMPORT_USER_ID;

      // supersedes chain: seq 0 = null, seq N → id of seq N-1
      const supersedes = g.seq > 0 ? idsBySeq.get(g.seq - 1) : null;

      const extId = `quote::${number}`;

      sqlStatements.push(
        [
          `INSERT INTO quotes`,
          `  (id, number, opportunity_id, revision, quote_type, status,`,
          `   title, description, valid_until, currency,`,
          `   subtotal_price, tax_amount, total_price,`,
          `   incoterms, payment_terms, delivery_terms, delivery_estimate,`,
          `   tc_revision, warranty_revision, rate_schedule_revision, sop_revision,`,
          `   supersedes_quote_id, cost_build_id,`,
          `   submitted_at, submitted_by_user_id,`,
          `   notes_internal, notes_customer,`,
          `   external_source, external_id,`,
          `   created_at, updated_at, created_by_user_id,`,
          `   quote_seq, show_discounts, quote_due_date)`,
          `VALUES (`,
          `  ${sqlLit(id)}, ${sqlLit(number)}, ${sqlLit(oppId)}, ${sqlLit(revision)}, ${sqlLit(oppTxnType)}, ${sqlLit(pipelineStatus)},`,
          `  ${sqlLit(title)}, NULL, ${sqlLit(validUntilIso)}, 'USD',`,
          `  ${sqlLit(totalVal)}, 0, ${sqlLit(totalVal)},`,
          `  NULL, NULL, NULL, NULL,`,
          `  NULL, NULL, NULL, NULL,`,
          `  ${sqlLit(supersedes)}, NULL,`,
          `  NULL, NULL,`,
          `  NULL, NULL,`,
          `  ${sqlLit(EXTERNAL_SOURCE)}, ${sqlLit(extId)},`,
          `  ${sqlLit(createdAt)}, ${sqlLit(ts)}, ${sqlLit(createdByUserId)},`,
          `  ${sqlLit(g.seq)}, 1, ${sqlLit(quoteDueDateIso)}`,
          `);`,
        ].join('\n')
      );

      // audit event for quote creation
      const auditId = uuid();
      const changesJson = JSON.stringify({
        number,
        opportunity_id: oppId,
        opportunity_number: oppNumber,
        revision,
        quote_type: oppTxnType,
        status: pipelineStatus,
        wfm_status: wfmStatus,
        title,
        total_price: totalVal,
        valid_until: validUntilIso,
        quote_due_date: quoteDueDateIso,
        wfm_sales_person: sales || null,
        created_by_user_id: createdByUserId,
        supersedes_quote_id: supersedes,
        external_source: EXTERNAL_SOURCE,
        external_id: extId,
        import_source_file: 'WFM_Quotes.xlsx',
        opp_origin: rg.opp ? 'matched-wfm01-lead' : 'orphan-wfm02',
      });
      sqlStatements.push(
        [
          `INSERT INTO audit_events`,
          `  (id, entity_type, entity_id, event_type, user_id, at,`,
          `   summary, changes_json, override_reason)`,
          `VALUES (`,
          `  ${sqlLit(auditId)}, 'quote', ${sqlLit(id)}, 'created',`,
          `  ${sqlLit(IMPORT_USER_ID)}, ${sqlLit(ts)},`,
          `  ${sqlLit(`Imported from WFM: ${number} rev ${revision} — "${title}" (${oppNumber})`)}, ${sqlLit(changesJson)}, NULL`,
          `);`,
        ].join('\n')
      );

      previewRows.push({
        quote_number: number,
        revision,
        wfm_status: wfmStatus,
        pipeline_status: pipelineStatus,
        title,
        account_name: rg.account.name,
        opp_number: oppNumber,
        opp_origin: rg.opp ? 'matched' : 'orphan',
        quote_type: oppTxnType,
        total_price: totalVal,
        valid_until: validUntilIso || '',
        quote_due_date: quoteDueDateIso || '',
        wfm_sales_person: sales || '',
        created_by_user_id: createdByUserId,
        supersedes_quote_id: supersedes || '',
        external_id: extId,
      });

      summaryRows.push({
        quote_number: number,
        new_quote_id: id,
        opp_number: oppNumber,
        new_opp_id: oppId,
        opp_origin: rg.opp ? 'matched' : 'orphan',
        external_id: extId,
        status: 'pending',
      });
    }
  }

  // ---- Rollback SQL ----
  // Order matters: delete audit events first (FK-safe), then child quotes,
  // then orphan opps. We target by external_id prefix so only rows created
  // by THIS import get removed. The quotes-orphan:: opps only exist because
  // of this import; the quote:: rows likewise.
  rollbackStatements.push(
    `-- Rollback for wfm-quotes-import.sql`,
    `-- Deletes only rows created by the quotes import. Does NOT touch the`,
    `-- 196 WFM01-0001 … WFM01-0196 opps (those belong to the opportunities`,
    `-- phase and have external_id's without the 'quotes-orphan::' prefix).`,
    ``,
    `-- 1. Audit events for imported quotes`,
    `DELETE FROM audit_events`,
    `WHERE entity_type='quote'`,
    `  AND entity_id IN (SELECT id FROM quotes WHERE external_source='wfm' AND external_id LIKE 'quote::%');`,
    ``,
    `-- 2. Audit events for orphan opps created by the quotes import`,
    `DELETE FROM audit_events`,
    `WHERE entity_type='opportunity'`,
    `  AND entity_id IN (SELECT id FROM opportunities WHERE external_source='wfm' AND external_id LIKE 'quotes-orphan::%');`,
    ``,
    `-- 3. Quotes (rows with external_id starting 'quote::')`,
    `DELETE FROM quotes WHERE external_source='wfm' AND external_id LIKE 'quote::%';`,
    ``,
    `-- 4. Orphan opps (rows with external_id starting 'quotes-orphan::')`,
    `DELETE FROM opportunities WHERE external_source='wfm' AND external_id LIKE 'quotes-orphan::%';`,
    ``
  );

  console.log(`  Resolution:`);
  console.log(`    exact matches to existing WFM01 opp: ${exactMatches} base groups`);
  console.log(`    orphan opps (new WFM02):              ${orphanOpps} base groups`);
  console.log(`    skipped (no account):                 ${skippedNoAccount} base groups`);
  console.log(`    total quote rows emitted:             ${previewRows.length}`);

  return { sqlStatements, rollbackStatements, previewRows, summaryRows };
}

// ---------------------------------------------------------------------
// wrangler runner
// ---------------------------------------------------------------------

function runWrangler(sqlFile, { local, remote }) {
  const envFlag = remote ? '--remote' : '--local';
  // wrangler is launched via cmd.exe on Windows (shell:true), which
  // does NOT honor array-arg quoting — so an absolute path with spaces
  // (e.g. "C-LARS Sales - Documents") splits into multiple argv tokens
  // and wrangler rejects the tail as unknown positionals. Convert to
  // a repo-relative path (cwd is the project root) so no argv token
  // contains whitespace.
  const relSqlFile = path.relative(process.cwd(), sqlFile).replace(/\\/g, '/');
  const cmd = 'npx';
  const args = [
    'wrangler',
    'd1',
    'execute',
    'c-lars-pms-db',
    envFlag,
    '--file',
    relSqlFile,
  ];
  console.log(`\n→ Running: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler exited with code ${result.status}. See output above.`
    );
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

// Populated only by the 'quotes' entity case; consumed by the writer
// below to emit a companion rollback .sql file next to the forward SQL.
let __quotesRollbackStatements = null;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.entity) fail('--entity is required (e.g. --entity accounts)');
  if (!args.file) fail('--file is required');
  if (!args.dryRun && !args.commit) fail('one of --dry-run / --commit is required');
  if (args.dryRun && args.commit) fail('--dry-run and --commit are mutually exclusive');
  if (args.commit && !args.local && !args.remote) fail('--commit requires --local or --remote');
  if (args.commit && args.local && args.remote) fail('--local and --remote are mutually exclusive');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\nWFM → Pipeline importer`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`  entity: ${args.entity}`);
  console.log(`  file:   ${args.file}`);
  console.log(`  mode:   ${args.dryRun ? 'DRY-RUN' : 'COMMIT'}`);
  if (args.commit) console.log(`  target: ${args.remote ? 'remote' : 'local'}`);
  console.log('');

  const rows = readXlsxRows(args.file);
  console.log(`Parsed ${rows.length} rows from spreadsheet.`);

  let sqlStatements, previewRows, summaryRows;

  switch (args.entity) {
    case 'accounts':
      ({ sqlStatements, previewRows, summaryRows } = buildAccountsStatements(rows));
      break;
    case 'contacts': {
      const accountLookup = loadAccountLookup();
      console.log(`Loaded ${accountLookup.size} WFM-origin accounts from lookup.`);
      ({ sqlStatements, previewRows, summaryRows } = buildContactsStatements(rows, accountLookup));
      break;
    }
    case 'opportunities': {
      const accountLookup = loadAccountLookup();
      const contactLookup = loadContactLookup();
      console.log(
        `Loaded ${accountLookup.size} WFM-origin accounts and ${contactLookup.size} WFM-origin contacts from lookups.`
      );
      ({ sqlStatements, previewRows, summaryRows } = buildOpportunitiesStatements(
        rows,
        accountLookup,
        contactLookup
      ));
      break;
    }
    case 'quotes': {
      const accountLookup = loadAccountLookup();
      const oppsLookup = loadOppsLookup();
      console.log(
        `Loaded ${accountLookup.size} WFM-origin accounts and ${oppsLookup.size} unique (account,title) keys from the opps lookup.`
      );
      let rollbackStatements;
      ({ sqlStatements, rollbackStatements, previewRows, summaryRows } = buildQuotesStatements(
        rows,
        accountLookup,
        oppsLookup
      ));
      // Stash on a module-local so the writer below can emit the rollback
      // SQL alongside the forward SQL.
      __quotesRollbackStatements = rollbackStatements;
      break;
    }
    default:
      fail(`Unknown --entity: ${args.entity}. Supported: accounts, contacts, opportunities, quotes`);
  }

  console.log(`Generated ${sqlStatements.length} SQL statements for ${previewRows.length} ${args.entity}.`);

  // Write the SQL file with a comment header explaining what it is.
  const sqlFile = path.join(OUT_DIR, `wfm-${args.entity}-import.sql`);
  const header = [
    `-- Generated by scripts/wfm-import.mjs on ${now()}`,
    `-- Source file: ${args.file}`,
    `-- Entity: ${args.entity}`,
    `-- Row count: ${previewRows.length}`,
    `-- DO NOT HAND-EDIT. Re-run the importer to regenerate.`,
    ``,
  ].join('\n');
  fs.writeFileSync(sqlFile, header + sqlStatements.join('\n\n') + '\n', 'utf8');
  console.log(`  SQL written:     ${sqlFile}`);

  // Rollback SQL (quotes entity only, for now — the accounts/contacts/opps
  // phases didn't need one because they were one-shot clean inserts).
  if (__quotesRollbackStatements && __quotesRollbackStatements.length > 0) {
    const rollbackFile = path.join(OUT_DIR, `wfm-${args.entity}-rollback.sql`);
    const rollbackHeader = [
      `-- Generated by scripts/wfm-import.mjs on ${now()}`,
      `-- Rollback script for: wfm-${args.entity}-import.sql`,
      `-- Run via: npx wrangler d1 execute c-lars-pms-db --remote --file scripts/out/wfm-${args.entity}-rollback.sql`,
      `-- Surgical: only touches rows with external_source='wfm' AND a quote-specific external_id prefix.`,
      ``,
    ].join('\n');
    fs.writeFileSync(rollbackFile, rollbackHeader + __quotesRollbackStatements.join('\n') + '\n', 'utf8');
    console.log(`  Rollback SQL:    ${rollbackFile}`);
  }

  // Write the human-readable preview CSV.
  const previewFile = path.join(OUT_DIR, `wfm-${args.entity}-import-preview.csv`);
  const previewHeaders = Object.keys(previewRows[0] ?? {});
  if (previewHeaders.length > 0) {
    writeCsv(previewFile, previewHeaders, previewRows);
    console.log(`  Preview CSV:     ${previewFile}`);
  }

  if (args.dryRun) {
    console.log('\nDry-run complete. Nothing was sent to D1.');
    console.log('Review the preview CSV, then re-run with --commit --local or --commit --remote.');
    return;
  }

  // --commit: shell out to wrangler
  runWrangler(sqlFile, { local: args.local, remote: args.remote });

  // Mark summary rows as imported. This file is useful after the fact
  // to map WFM names → new Pipeline UUIDs.
  summaryRows.forEach((r) => (r.status = 'imported'));
  const summaryFile = path.join(OUT_DIR, `wfm-${args.entity}-import-summary.csv`);
  writeCsv(summaryFile, Object.keys(summaryRows[0]), summaryRows);
  console.log(`\nCommit succeeded. Summary written: ${summaryFile}`);
}

function fail(msg) {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
