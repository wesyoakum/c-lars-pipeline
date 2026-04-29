// functions/ai-inbox/[id]/edit.js
//
// POST /ai-inbox/:id/edit
//
// Inline-edit endpoint. Accepts a JSON body containing a partial
// extraction object and merges it into the stored extracted_json.
// The raw_transcript is never overwritten here.
//
// Body shape (any subset of these fields):
//   {
//     title, summary, confidence,
//     people: [...], organizations: [...],
//     action_items: [{task, owner, due}, ...],
//     open_questions: [...], tags: [...],
//     suggested_destinations: [...]
//   }

import { one, run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';

const ALLOWED_FIELDS = new Set([
  'title', 'summary', 'confidence',
  'people', 'organizations', 'action_items', 'open_questions',
  'requirements',
  'tags', 'suggested_destinations',
  'people_detail', 'organizations_detail',
]);

const REQUIREMENT_CATEGORIES = new Set([
  'performance', 'operational', 'interface',
  'environmental', 'regulatory', 'commercial', 'other',
]);

const ALLOWED_DESTINATIONS = new Set([
  'keep_as_note', 'create_task', 'create_reminder',
  'link_to_account', 'link_to_opportunity', 'archive',
]);

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT extracted_json FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  let current = {};
  if (item.extracted_json) {
    try { current = JSON.parse(item.extracted_json); } catch { current = {}; }
  }

  const merged = { ...current };
  for (const [k, v] of Object.entries(payload || {})) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    merged[k] = sanitize(k, v);
  }

  await run(
    env.DB,
    'UPDATE ai_inbox_items SET extracted_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(merged), now(), params.id]
  );

  return json({ ok: true, fields: merged });
}

function sanitize(name, value) {
  if (name === 'confidence') {
    const v = String(value || '').toLowerCase();
    return CONFIDENCE_VALUES.has(v) ? v : 'medium';
  }
  if (name === 'title' || name === 'summary') {
    return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
  }
  if (name === 'people' || name === 'organizations' ||
      name === 'open_questions' || name === 'tags') {
    if (!Array.isArray(value)) return [];
    return value.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  }
  if (name === 'action_items') {
    if (!Array.isArray(value)) return [];
    return value.map((a) => ({
      task: typeof a?.task === 'string' ? a.task.trim() : '',
      owner: typeof a?.owner === 'string' ? a.owner.trim() : '',
      due: typeof a?.due === 'string' ? a.due.trim() : '',
    })).filter((a) => a.task);
  }
  if (name === 'requirements') {
    if (!Array.isArray(value)) return [];
    return value.map((r) => {
      // Tolerate string entries (older payloads / paste-in flows).
      if (typeof r === 'string') {
        return { text: r.trim(), category: 'other' };
      }
      const cat = typeof r?.category === 'string' ? r.category.trim().toLowerCase() : '';
      return {
        text: typeof r?.text === 'string' ? r.text.trim() : '',
        category: REQUIREMENT_CATEGORIES.has(cat) ? cat : 'other',
      };
    }).filter((r) => r.text);
  }
  if (name === 'suggested_destinations') {
    if (!Array.isArray(value)) return [];
    return value
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => ALLOWED_DESTINATIONS.has(s));
  }
  if (name === 'people_detail') {
    if (!Array.isArray(value)) return [];
    return value.map((p) => ({
      name: typeof p?.name === 'string' ? p.name.trim() : '',
      title: typeof p?.title === 'string' ? p.title.trim() : '',
      email: typeof p?.email === 'string' ? p.email.trim() : '',
      phone: typeof p?.phone === 'string' ? p.phone.trim() : '',
      organization: typeof p?.organization === 'string' ? p.organization.trim() : '',
    })).filter((p) => p.name);
  }
  if (name === 'organizations_detail') {
    if (!Array.isArray(value)) return [];
    return value.map((o) => ({
      name: typeof o?.name === 'string' ? o.name.trim() : '',
      phone: typeof o?.phone === 'string' ? o.phone.trim() : '',
      email: typeof o?.email === 'string' ? o.email.trim() : '',
      website: typeof o?.website === 'string' ? o.website.trim() : '',
      address: typeof o?.address === 'string' ? o.address.trim() : '',
    })).filter((o) => o.name);
  }
  return value;
}
