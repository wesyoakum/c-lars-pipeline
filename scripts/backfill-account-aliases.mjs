#!/usr/bin/env node
//
// scripts/backfill-account-aliases.mjs
//
// One-shot backfill: populate accounts.alias for rows where it's NULL or
// empty by deriving a conversational alias from the legal name (strip
// ", LLC" / ", Inc." / etc.). Reuses deriveAlias() from the validator so
// the rule stays in one place.
//
// Usage:
//   node scripts/backfill-account-aliases.mjs --local
//   node scripts/backfill-account-aliases.mjs --remote
//   (add --dry-run to preview without writing)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deriveAlias } from '../functions/lib/validators.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Use a relative path for SQL artifacts so wrangler invocations on
// Windows aren't tripped up by absolute paths containing spaces.
const OUT_DIR = path.join('scripts', 'out');

const args = process.argv.slice(2);
const local = args.includes('--local');
const remote = args.includes('--remote');
const dryRun = args.includes('--dry-run');

if (local === remote) {
  console.error('Specify exactly one of --local or --remote.');
  process.exit(2);
}

const target = local ? '--local' : '--remote';

console.log(`Backfilling account aliases on ${local ? 'LOCAL' : 'REMOTE'} D1${dryRun ? ' (dry-run)' : ''}`);

// 1. Select accounts that need an alias. Use --command (the SQL has no
// spaces in any path) and parse wrangler's stdout as JSON after stripping
// the "├ Checking…" / "🌀 Uploading…" status lines wrangler prints
// before the actual JSON body.
fs.mkdirSync(OUT_DIR, { recursive: true });
const selectSql = `SELECT id, name, alias FROM accounts WHERE alias IS NULL OR TRIM(alias) = ''`;
const selectResult = spawnSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'c-lars-pms-db', target, '--command', `"${selectSql}"`],
  { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf-8', shell: true }
);

if (selectResult.status !== 0) {
  console.error('Wrangler SELECT failed.');
  process.exit(selectResult.status || 1);
}

// Skip wrangler's pre-output status lines and grab the JSON body.
const rawOut = selectResult.stdout || '';
const jsonStart = rawOut.indexOf('[');
let parsed;
try {
  parsed = JSON.parse(rawOut.slice(jsonStart));
} catch (e) {
  console.error('Could not parse wrangler output:', e.message);
  console.error(rawOut);
  process.exit(1);
}

// wrangler d1 execute --json returns an array of result blocks.
const resultBlock = Array.isArray(parsed) ? parsed[0] : parsed;
const rows = resultBlock?.results || [];

if (!rows.length) {
  console.log('No accounts need backfilling.');
  process.exit(0);
}

console.log(`Found ${rows.length} account(s) without an alias.`);

// 2. Compute new aliases. Skip rows where deriveAlias returns empty
// (would just be the same as name and that's not useful).
const updates = [];
for (const row of rows) {
  const newAlias = deriveAlias(row.name || '');
  if (!newAlias) continue;
  updates.push({ id: row.id, name: row.name, alias: newAlias });
}

console.log(`Will set alias on ${updates.length} row(s).`);
for (const u of updates.slice(0, 20)) {
  console.log(`  ${u.id}  "${u.name}" → "${u.alias}"`);
}
if (updates.length > 20) console.log(`  …and ${updates.length - 20} more.`);

if (dryRun) {
  console.log('Dry-run: nothing written.');
  process.exit(0);
}

if (!updates.length) {
  console.log('Nothing to write.');
  process.exit(0);
}

// 3. Build a single SQL file with all UPDATEs and execute it.
const sqlPath = path.join(OUT_DIR, 'backfill-account-aliases.sql');
const sqlEsc = (s) => String(s).replace(/'/g, "''");
const sql = updates
  .map((u) => `UPDATE accounts SET alias = '${sqlEsc(u.alias)}' WHERE id = '${sqlEsc(u.id)}';`)
  .join('\n') + '\n';
fs.writeFileSync(sqlPath, sql, 'utf-8');
console.log(`Wrote ${updates.length} UPDATE(s) to ${sqlPath}`);

const updateResult = spawnSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'c-lars-pms-db', target, '--file', sqlPath],
  { stdio: 'inherit', shell: true }
);

if (updateResult.status !== 0) {
  console.error('Wrangler UPDATE failed.');
  process.exit(updateResult.status || 1);
}

console.log('Backfill complete.');
