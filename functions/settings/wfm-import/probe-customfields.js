// functions/settings/wfm-import/probe-customfields.js
//
// GET /settings/wfm-import/probe-customfields
//
// Diagnostic. Pulls /customfield.api/definition once and returns:
//
//   - The full flat list of every custom-field definition.
//   - Counts by Type (Text / Date / Checkbox / Number / Decimal / etc.)
//   - A pivot grouping by which WFM entity each field applies to
//     (UseClient / UseContact / UseSupplier / UseJob / UseLead /
//      UseJobTask / UseJobCost / UseJobTime / UseQuote).
//
// Useful for: enumerating every custom field once so we can decide
// which ones to promote to typed Pipeline columns vs. leave in
// wfm_payload.customFields.
//
// Admin-only.

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const USE_FLAGS = [
  'UseClient', 'UseContact', 'UseSupplier',
  'UseJob', 'UseLead',
  'UseJobTask', 'UseJobCost', 'UseJobTime',
  'UseQuote',
];

function isYes(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === 'yes' || s === '1';
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  try {
    const r = await apiGet(env, '/customfield.api/definition');
    if (!r.ok) {
      return json({
        ok: false,
        error: 'definition_call_failed',
        status: r.status,
        raw: r.rawText.slice(0, 1500),
      }, 502);
    }

    // The XML envelope is Response → CustomFieldDefinitions → CustomFieldDefinition[].
    let defs = recordList(r.body, 'CustomFieldDefinition');
    if (!Array.isArray(defs) || defs.length === 0) {
      // Fallback to other plural shapes the parser might surface.
      defs = recordList(r.body, 'CustomField');
    }

    // Normalize a few fields for easier downstream consumption.
    const flat = defs.map((d) => ({
      UUID: d.UUID,
      Name: d.Name,
      Type: d.Type,
      Mandatory: isYes(d.Mandatory),
      ValueElement: d.ValueElement,
      // Per-entity flags (booleans).
      uses: USE_FLAGS.reduce((acc, k) => {
        acc[k] = isYes(d[k]);
        return acc;
      }, {}),
      // Keep full record so the user can see options on dropdowns etc.
      raw: d,
    }));

    // Counts by type.
    const byType = {};
    for (const d of flat) {
      const t = d.Type || '(unknown)';
      byType[t] = (byType[t] || 0) + 1;
    }

    // Pivot by entity. Each entity bucket lists the fields that apply
    // to it, sorted by Name.
    const byEntity = {};
    for (const flag of USE_FLAGS) {
      const entity = flag.replace(/^Use/, '');   // 'Client', 'Quote', etc.
      const list = flat
        .filter((d) => d.uses[flag])
        .map((d) => ({
          name: d.Name,
          type: d.Type,
          mandatory: d.Mandatory,
          value_element: d.ValueElement,
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      byEntity[entity] = list;
    }

    // Quick subset the user specifically asked about: every Date-typed
    // field that applies to Quotes.
    const quoteDateFields = flat
      .filter((d) => d.uses.UseQuote && /date/i.test(d.Type || ''))
      .map((d) => d.Name);

    return json({
      ok: true,
      total_definitions: flat.length,
      by_type: byType,
      quote_date_fields: quoteDateFields,
      by_entity: byEntity,
      definitions_full: flat,
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
