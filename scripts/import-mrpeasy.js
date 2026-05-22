#!/usr/bin/env node
// scripts/import-mrpeasy.js
//
// One-time script to import MRPeasy CSV into D1 via wrangler d1 execute.
// Generates SQL INSERT statements and executes them in batches.
//
// Usage: node scripts/import-mrpeasy.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const CSV_PATH = path.join(__dirname, '..', 'MRPeasy Stock Complete Download.csv');
const DB_NAME = 'c-lars-pms-db';

// ── RFC 4180 CSV parser ──
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const row = [];
    while (i < len) {
      let value = '';
      if (text[i] === '"') {
        i++;
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') { value += '"'; i += 2; }
            else { i++; break; }
          } else { value += text[i]; i++; }
        }
      } else {
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') { value += text[i]; i++; }
      }
      row.push(value);
      if (i < len && text[i] === ',') { i++; } else { break; }
    }
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;
    if (row.length === 1 && row[0] === '' && i >= len) break;
    rows.push(row);
  }
  return rows;
}

const HEADER_MAP = {
  'Part No.': 'part_no',
  'Part description': 'part_description',
  'Parameters': 'parameters',
  'Group number': 'group_number',
  'Group name': 'group_name',
  'In stock': 'in_stock',
  'Packaged': 'packaged',
  'Rejected': 'rejected',
  'Expired': 'expired',
  'Available': 'available',
  'Booked': 'booked',
  'Expected, total': 'expected_total',
  'Expected, available': 'expected_available',
  'Expected, booked': 'expected_booked',
  'Work in progress': 'wip',
  'Reorder point': 'reorder_point',
  'Min. quantity for manufacturing': 'min_qty_mfg',
  'Cost': 'cost',
  'Selling price': 'selling_price',
  'UoM': 'uom',
  'Is procured item': 'is_procured',
  'Standalone MO': 'standalone_mo',
  'Is inventory item': 'is_inventory',
  'Lead time': 'lead_time',
  'Vendor number': 'vendor_number',
  'Vendor name': 'vendor_name',
  'Vendor part no.': 'vendor_part_no',
  'Default storage location': 'storage_location',
  'Weight': 'weight',
  'Unit of weight': 'weight_unit',
  'Revision': 'revision',
  'Serial numbers': 'serial_numbers',
  'Quality control': 'quality_control',
  'On-hold period': 'on_hold_period',
  'Shelf life': 'shelf_life',
};

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { if (v == null || v === '') return null; const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; }
function str(v) { if (v == null) return null; const s = String(v).trim(); return s || null; }
function firstLine(v) { if (!v) return null; const s = String(v).trim(); const nl = s.indexOf('\n'); return nl >= 0 ? s.slice(0, nl).trim() : s; }
function esc(v) { if (v == null) return 'NULL'; return "'" + String(v).replace(/'/g, "''") + "'"; }
function uuid() { return crypto.randomUUID(); }

// ── Main ──
const text = fs.readFileSync(CSV_PATH, 'utf-8');
const rows = parseCSV(text);
console.log(`Parsed ${rows.length - 1} data rows from CSV`);

const headers = rows[0];
const colIdx = {};
for (let i = 0; i < headers.length; i++) {
  const key = HEADER_MAP[headers[i].trim()];
  if (key) colIdx[key] = i;
}

const ts = new Date().toISOString();
const seen = new Set();
const inserts = [];

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const get = (key) => (colIdx[key] != null && row[colIdx[key]] != null) ? row[colIdx[key]] : null;

  const partNo = str(get('part_no'));
  const partDesc = str(get('part_description'));
  if (!partNo) continue;

  const dedupeKey = `${partNo}|||${partDesc || ''}`;
  if (seen.has(dedupeKey)) continue;
  seen.add(dedupeKey);

  const rawObj = {};
  for (const [hdr, key] of Object.entries(HEADER_MAP)) {
    const idx = colIdx[key];
    if (idx != null && row[idx] != null) rawObj[key] = row[idx];
  }

  const id = uuid();
  inserts.push(
    `INSERT INTO items_library (id, name, part_number, description, category, item_type, default_unit, default_price, default_cost, source, mrp_group_number, mrp_group_name, mrp_in_stock, mrp_available, mrp_booked, mrp_reorder_point, mrp_lead_time, mrp_vendor_number, mrp_vendor_name, mrp_vendor_part_number, mrp_storage_location, mrp_weight, mrp_weight_unit, mrp_is_procured, mrp_is_inventory, mrp_revision, mrp_raw_json, use_count, active, created_at, updated_at) VALUES (${esc(id)}, ${esc(partDesc || partNo)}, ${esc(partNo)}, ${esc(str(get('parameters')))}, ${esc(str(get('group_name')))}, 'product', ${esc(str(get('uom')) || 'EA')}, ${num(get('selling_price'))}, ${num(get('cost'))}, 'mrpeasy', ${esc(str(get('group_number')))}, ${esc(str(get('group_name')))}, ${num(get('in_stock'))}, ${num(get('available'))}, ${num(get('booked'))}, ${num(get('reorder_point'))}, ${int(get('lead_time'))}, ${esc(firstLine(get('vendor_number')))}, ${esc(firstLine(get('vendor_name')))}, ${esc(firstLine(get('vendor_part_no')))}, ${esc(str(get('storage_location')))}, ${num(get('weight'))}, ${esc(str(get('weight_unit')))}, ${int(get('is_procured'))}, ${int(get('is_inventory'))}, ${esc(str(get('revision')))}, ${esc(JSON.stringify(rawObj))}, 0, 1, ${esc(ts)}, ${esc(ts)});`
  );
}

console.log(`${inserts.length} unique items to import (${rows.length - 1 - inserts.length} dupes skipped)`);

// Write to temp SQL files and execute in batches (D1 has size limits per file)
const BATCH_SIZE = 200;
const tmpDir = path.join(__dirname, '..', '.tmp-import');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const batches = [];
for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
  const batch = inserts.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const filePath = path.join(tmpDir, `batch_${String(batchNum).padStart(3, '0')}.sql`);
  fs.writeFileSync(filePath, batch.join('\n'));
  batches.push({ num: batchNum, path: filePath, count: batch.length });
}

console.log(`Split into ${batches.length} batch files`);

let totalImported = 0;
for (const b of batches) {
  process.stdout.write(`  Batch ${b.num}/${batches.length} (${b.count} rows)... `);
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file="${b.path}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    totalImported += b.count;
    console.log('OK');
  } catch (err) {
    console.log('FAILED');
    console.error(err.stderr?.toString() || err.message);
    break;
  }
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nDone! Imported ${totalImported} of ${inserts.length} items.`);
