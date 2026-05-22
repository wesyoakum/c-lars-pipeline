// functions/lib/items-library.js
//
// Shared helper for the auto-populated items library.
// Called after every quote line save to upsert the item into the
// library so it's available for future reuse.

import { one, run } from './db.js';

/**
 * Upsert a quote line into items_library. Fire-and-forget — never
 * throws, never blocks the line save.
 *
 * Dedup key: part_number (preferred) or LOWER(TRIM(title)).
 *
 * @returns {string|null} The library item ID (for setting item_library_id on the line).
 */
export async function upsertLibraryItem(db, line) {
  try {
    const title = String(line.title || '').trim();
    const partNumber = String(line.part_number || '').trim();
    if (!title && !partNumber) return null;

    const ts = new Date().toISOString();
    let existing = null;

    // Match by part_number first (more specific).
    if (partNumber) {
      existing = await one(db,
        `SELECT id, use_count FROM items_library
          WHERE part_number = ? AND deleted_at IS NULL LIMIT 1`,
        [partNumber]);
    }
    // Fallback: match by title (case-insensitive).
    if (!existing && title) {
      existing = await one(db,
        `SELECT id, use_count FROM items_library
          WHERE LOWER(TRIM(name)) = LOWER(?) AND deleted_at IS NULL LIMIT 1`,
        [title]);
    }

    if (existing) {
      await run(db,
        `UPDATE items_library
            SET default_price = ?, default_unit = ?, default_cost = ?,
                item_type = ?, description = ?,
                part_number = COALESCE(?, part_number),
                use_count = use_count + 1,
                last_used_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          line.unit_price ?? 0,
          line.unit || 'ea',
          line.unit_cost ?? null,
          line.item_type || 'product',
          line.description || '',
          partNumber || null,
          ts, ts,
          existing.id,
        ]);
      return existing.id;
    } else {
      const id = crypto.randomUUID();
      await run(db,
        `INSERT INTO items_library
           (id, name, description, default_unit, default_price, default_cost,
            part_number, item_type, use_count, last_used_at, item_notes,
            category, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, 1, ?, ?)`,
        [
          id,
          title || partNumber,
          line.description || '',
          line.unit || 'ea',
          line.unit_price ?? 0,
          line.unit_cost ?? null,
          partNumber || null,
          line.item_type || 'product',
          ts, ts, ts,
        ]);
      return id;
    }
  } catch (err) {
    console.error('[items-library] upsert failed:', err?.message || err);
    return null;
  }
}

/**
 * Backfill the items_library from all existing quote_lines.
 * Groups by part_number (preferred) or LOWER(TRIM(title)).
 * Returns { inserted, updated }.
 */
export async function backfillLibrary(db) {
  const { all } = await import('./db.js');
  const lines = await all(db,
    `SELECT title, part_number, description, item_type, unit, unit_price,
            MAX(updated_at) AS latest_at,
            COUNT(*) AS cnt
       FROM quote_lines
      WHERE deleted_at IS NULL
        AND (title IS NOT NULL AND title != '' OR part_number IS NOT NULL AND part_number != '')
      GROUP BY COALESCE(NULLIF(TRIM(part_number), ''), LOWER(TRIM(title)))
      ORDER BY cnt DESC`);

  let inserted = 0, updated = 0;
  for (const l of lines) {
    const id = await upsertLibraryItem(db, {
      title: l.title,
      part_number: l.part_number,
      description: l.description,
      item_type: l.item_type,
      unit: l.unit,
      unit_price: l.unit_price,
      unit_cost: null,
    });
    if (id) {
      // Set the correct use_count (the upsert increments by 1, but we want the actual count).
      await run(db,
        `UPDATE items_library SET use_count = ?, last_used_at = ? WHERE id = ?`,
        [l.cnt, l.latest_at, id]);
      inserted++;
    }
  }
  return { inserted, updated };
}
