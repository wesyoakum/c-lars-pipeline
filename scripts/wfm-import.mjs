#!/usr/bin/env node
//
// scripts/wfm-import.mjs
//
// Bulk importer for WorkflowMax (WFM) exports into the C-LARS PMS D1.
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
//   - This first cut only knows how to import `accounts`. Adding
//     contacts / opportunities / quotes is a matter of adding another
//     `buildXxxStatements()` function and a case to the switch below.

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
scripts/wfm-import.mjs — WFM → PMS importer

  --entity <name>   One of: accounts   (contacts/opportunities/quotes TBD)
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

    // 1. accounts row
    sqlStatements.push(
      [
        `INSERT INTO accounts`,
        `  (id, name, segment, address_billing, address_physical,`,
        `   phone, website, notes, owner_user_id,`,
        `   external_source, external_id,`,
        `   created_at, updated_at, created_by_user_id)`,
        `VALUES (`,
        `  ${sqlLit(id)}, ${sqlLit(rawName)}, NULL, ${sqlLit(rawAddress)}, NULL,`,
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.entity) fail('--entity is required (e.g. --entity accounts)');
  if (!args.file) fail('--file is required');
  if (!args.dryRun && !args.commit) fail('one of --dry-run / --commit is required');
  if (args.dryRun && args.commit) fail('--dry-run and --commit are mutually exclusive');
  if (args.commit && !args.local && !args.remote) fail('--commit requires --local or --remote');
  if (args.commit && args.local && args.remote) fail('--local and --remote are mutually exclusive');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\nWFM → PMS importer`);
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
    default:
      fail(`Unknown --entity: ${args.entity}. Supported: accounts`);
  }

  console.log(`Generated ${sqlStatements.length} SQL statements for ${previewRows.length} accounts.`);

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
  // to map WFM names → new PMS UUIDs.
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
