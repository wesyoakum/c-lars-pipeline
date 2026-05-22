// functions/api/mrpeasy-import.js
//
// POST /api/mrpeasy-import — admin-only bulk import of MRPeasy CSV into
// items_library with source = 'mrpeasy'. Accepts multipart form with a
// single CSV file. Parses RFC 4180 (quoted fields, embedded newlines).

import { stmt, batch } from '../lib/db.js';
import { uuid, now } from '../lib/ids.js';
import { hasRole } from '../lib/auth.js';

// ── RFC 4180 CSV parser (handles quoted fields with newlines/commas) ──

function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      let value = '';
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            value += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
          value += text[i];
          i++;
        }
      }
      row.push(value);

      if (i < len && text[i] === ',') {
        i++; // skip comma, continue to next field
      } else {
        break; // end of row
      }
    }
    // Skip line endings
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;

    // Skip empty trailing row
    if (row.length === 1 && row[0] === '' && i >= len) break;
    rows.push(row);
  }
  return rows;
}

// ── Column mapping ──

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

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// For multi-line vendor fields, take the first line only
function firstLine(v) {
  if (!v) return null;
  const s = String(v).trim();
  const nl = s.indexOf('\n');
  return nl >= 0 ? s.slice(0, nl).trim() : s;
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin role required.' }, 403);
  }

  // Read the CSV from the multipart form
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || typeof file.text !== 'function') {
    return json({ ok: false, error: 'No CSV file provided.' }, 400);
  }

  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) {
    return json({ ok: false, error: 'CSV has no data rows.' }, 400);
  }

  // Map headers
  const headers = rows[0];
  const colIdx = {};
  for (let i = 0; i < headers.length; i++) {
    const key = HEADER_MAP[headers[i].trim()];
    if (key) colIdx[key] = i;
  }

  if (colIdx.part_no == null) {
    return json({ ok: false, error: 'Missing "Part No." column in CSV.' }, 400);
  }

  const ts = now();
  const statements = [];
  let imported = 0;
  let skipped = 0;
  const seen = new Set(); // dedupe within CSV

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (key) => (colIdx[key] != null && row[colIdx[key]] != null) ? row[colIdx[key]] : null;

    const partNo = str(get('part_no'));
    const partDesc = str(get('part_description'));
    if (!partNo) { skipped++; continue; }

    // Dedupe within CSV: same part_no + same description
    const dedupeKey = `${partNo}|||${partDesc || ''}`;
    if (seen.has(dedupeKey)) { skipped++; continue; }
    seen.add(dedupeKey);

    // Build raw JSON object from all columns
    const rawObj = {};
    for (const [hdr, key] of Object.entries(HEADER_MAP)) {
      const idx = colIdx[key];
      if (idx != null && row[idx] != null) rawObj[key] = row[idx];
    }

    const id = uuid();
    statements.push(stmt(env.DB,
      `INSERT INTO items_library (
         id, name, part_number, description, category, item_type,
         default_unit, default_price, default_cost, source,
         mrp_group_number, mrp_group_name, mrp_in_stock, mrp_available,
         mrp_booked, mrp_reorder_point, mrp_lead_time,
         mrp_vendor_number, mrp_vendor_name, mrp_vendor_part_number,
         mrp_storage_location, mrp_weight, mrp_weight_unit,
         mrp_is_procured, mrp_is_inventory, mrp_revision,
         mrp_raw_json, use_count, active, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, 'product',
         ?, ?, ?, 'mrpeasy',
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, 0, 1, ?, ?
       )`,
      [
        id,
        partDesc || partNo,             // name
        partNo,                           // part_number
        str(get('parameters')),           // description (Parameters field)
        str(get('group_name')),           // category
        str(get('uom')) || 'EA',          // default_unit
        num(get('selling_price')),        // default_price
        num(get('cost')),                 // default_cost
        str(get('group_number')),         // mrp_group_number
        str(get('group_name')),           // mrp_group_name
        num(get('in_stock')),             // mrp_in_stock
        num(get('available')),            // mrp_available
        num(get('booked')),               // mrp_booked
        num(get('reorder_point')),        // mrp_reorder_point
        int(get('lead_time')),            // mrp_lead_time
        firstLine(get('vendor_number')),  // mrp_vendor_number
        firstLine(get('vendor_name')),    // mrp_vendor_name
        firstLine(get('vendor_part_no')), // mrp_vendor_part_number
        str(get('storage_location')),     // mrp_storage_location
        num(get('weight')),               // mrp_weight
        str(get('weight_unit')),          // mrp_weight_unit
        int(get('is_procured')),          // mrp_is_procured
        int(get('is_inventory')),         // mrp_is_inventory
        str(get('revision')),             // mrp_revision
        JSON.stringify(rawObj),           // mrp_raw_json
        ts, ts,                           // created_at, updated_at
      ]
    ));
    imported++;
  }

  // D1 batch limit is ~100 statements. Chunk into batches of 50.
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await batch(env.DB, statements.slice(i, i + CHUNK));
  }

  return json({ ok: true, imported, skipped });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
