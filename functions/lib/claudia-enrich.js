// functions/lib/claudia-enrich.js
//
// Cross-reference enrichment helper for Claudia's event-driven worker.
// Given a claudia_events_pending row, resolves the principal entity
// + related Pipeline rows + related claudia_documents / ai_inbox_items
// + recent audit timeline + currently-open claudia_actions in the same
// entity cluster.
//
// The output feeds the action extractor's prompt and is also persisted
// onto the resulting claudia_actions row's context_json so the UI can
// render "what Claudia knew when she classified this."
//
// Pure data gathering — no model calls, no writes. Bounded LIMITs on
// every query so the worker stays fast and the prompt stays small.
//
// Hard line: NEVER queries Gmail tables. Gmail = Wes's personal life;
// CRM context comes from claudia_documents + ai_inbox_items + Pipeline
// only.

import { all, one } from './db.js';

// Compact row shapes — drop columns the model doesn't need, but send
// the FULL email body (capped only as a safety net against pathological
// 1 MB+ outliers). Per Wes's directive: every email in cross-reference
// gets its full body so the model can reason about actual contents,
// not hedge from snippets. Sonnet's 200 K-token input window absorbs
// even 6–8 long threads comfortably.
//
// Two variants share the cap; principalDoc carries a couple of extra
// metadata fields (email_date, summary) that aren't worth shipping for
// every sibling.

const DOC_TEXT_CAP = 150 * 1024;   // 150 KB (~37 K tokens) — effectively "all of every email" in 99.9% of cases.

function clampText(s) {
  if (!s) return null;
  const str = String(s);
  if (str.length <= DOC_TEXT_CAP) return str;
  return str.slice(0, DOC_TEXT_CAP) + `\n[... ${str.length - DOC_TEXT_CAP} more chars truncated ...]`;
}

function principalDoc(d) {
  if (!d) return null;
  const fullText = d.full_text ? String(d.full_text) : null;
  return {
    id: d.id,
    seq: d.seq ?? null,
    filename: d.filename ?? null,
    subject: d.subject ?? null,
    sender_email: d.sender_email ?? null,
    sender_name: d.sender_name ?? null,
    email_date: d.email_date ?? null,
    category: d.category ?? null,
    retention: d.retention ?? null,
    summary: d.summary ?? null,
    full_text: clampText(fullText),
    full_text_chars: fullText ? fullText.length : 0,
    created_at: d.created_at,
  };
}

function compactDoc(d) {
  if (!d) return null;
  const fullText = d.full_text ? String(d.full_text) : null;
  return {
    id: d.id,
    seq: d.seq ?? null,
    filename: d.filename ?? null,
    subject: d.subject ?? null,
    sender_email: d.sender_email ?? null,
    sender_name: d.sender_name ?? null,
    email_date: d.email_date ?? null,
    category: d.category ?? null,
    retention: d.retention ?? null,
    full_text: clampText(fullText),
    full_text_chars: fullText ? fullText.length : 0,
    created_at: d.created_at,
  };
}

function compactInboxItem(i) {
  if (!i) return null;
  let extracted = null;
  try { extracted = i.extracted_json ? JSON.parse(i.extracted_json) : null; } catch { /* ignore */ }
  return {
    id: i.id,
    title: extracted?.title ?? null,
    summary: extracted?.summary ?? null,
    suggested_destinations: extracted?.suggested_destinations ?? [],
    confidence: extracted?.confidence ?? null,
    created_at: i.created_at,
  };
}

function compactAccount(a) {
  if (!a) return null;
  return {
    id: a.id, name: a.name, segment: a.segment ?? null,
    alias: a.alias ?? null, parent_group: a.parent_group ?? null,
    is_active: a.is_active ?? 1,
    intel_notes_present: !!a.intel_notes,
  };
}

function compactOpp(o) {
  if (!o) return null;
  return {
    id: o.id, number: o.number, title: o.title,
    stage: o.stage, account_id: o.account_id,
    estimated_value_usd: o.estimated_value_usd ?? null,
    expected_close_date: o.expected_close_date ?? null,
    transaction_type: o.transaction_type ?? null,
  };
}

function compactContact(c) {
  if (!c) return null;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null;
  return {
    id: c.id, name, account_id: c.account_id,
    title: c.title ?? null, email: c.email ?? null,
  };
}

function compactActivity(t) {
  if (!t) return null;
  return {
    id: t.id, type: t.type, subject: t.subject ?? null,
    status: t.status ?? null, due_at: t.due_at ?? null,
    completed_at: t.completed_at ?? null,
    account_id: t.account_id ?? null,
    opportunity_id: t.opportunity_id ?? null,
  };
}

function compactQuote(q) {
  if (!q) return null;
  return {
    id: q.id, number: q.number, status: q.status ?? null,
    opportunity_id: q.opportunity_id ?? null,
    grand_total_usd: q.grand_total_usd ?? null,
  };
}

function compactAudit(a) {
  if (!a) return null;
  return {
    entity_type: a.entity_type, event_type: a.event_type,
    summary: a.summary ?? null, at: a.at,
  };
}

function compactAction(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title,
    quadrant: r.quadrant, source_kind: r.source_kind,
    due_at: r.due_at ?? null, status: r.status,
  };
}

// Empty enrichment scaffold — the worker should always get a
// well-shaped object even when lookup fails.
function emptyEnrichment(event) {
  return {
    event,
    principal: null,
    related: {
      docs: [],
      inbox_items: [],
      accounts: [],
      opportunities: [],
      contacts: [],
      activities: [],
      quotes: [],
      audit_recent: [],
    },
    open_actions: [],
    notes: [],
  };
}

// Match opp numbers in free text. Format: WFM02-25314 (legacy WFM-imported)
// or PMS-25314 / PMS25-25314 (homegrown). Keep liberal — we want hits.
const OPP_NUMBER_RE = /\b(WFM\d{2}|PMS\d{2}|PMS)-?\d{3,6}\b/gi;

function extractOppNumbersFromText(...texts) {
  const seen = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(OPP_NUMBER_RE)) seen.add(m[0]);
  }
  return Array.from(seen);
}

// Recent audit timeline for one entity.
async function recentAudit(env, entityType, entityId, limit = 5) {
  return all(
    env.DB,
    `SELECT entity_type, event_type, summary, at
       FROM audit_events
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY at DESC LIMIT ?`,
    [entityType, entityId, limit]
  );
}

// Open claudia_actions referencing any of the entity-cluster rows.
async function openActionsForCluster(env, userId, refs) {
  if (!refs?.length) return [];
  // refs: [{ table, id }] — collapse to ids per table for one IN per table.
  const byTable = new Map();
  for (const r of refs) {
    if (!r?.table || !r?.id) continue;
    if (!byTable.has(r.table)) byTable.set(r.table, new Set());
    byTable.get(r.table).add(r.id);
  }
  const out = [];
  for (const [table, idSet] of byTable.entries()) {
    const ids = Array.from(idSet);
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await all(
      env.DB,
      `SELECT id, title, quadrant, source_kind, due_at, status
         FROM claudia_actions
        WHERE user_id = ? AND status = 'open'
          AND source_ref_table = ?
          AND source_ref_id IN (${placeholders})
        ORDER BY created_at DESC LIMIT 10`,
      [userId, table, ...ids]
    );
    out.push(...rows);
  }
  // De-dup by id, cap at 10 total.
  const dedup = new Map();
  for (const r of out) dedup.set(r.id, r);
  return Array.from(dedup.values()).slice(0, 10);
}

// ─── Per-entity enrichers ────────────────────────────────────────────

async function enrichDocument(env, event, userId) {
  const doc = await one(env.DB, `SELECT * FROM claudia_documents WHERE id = ?`, [event.refId]);
  if (!doc) return emptyEnrichment(event);

  const out = emptyEnrichment(event);
  // Principal gets the full body — the model needs to actually read
  // the email, not hedge from a 240-char snippet.
  out.principal = principalDoc(doc);

  const oppNumbers = extractOppNumbersFromText(doc.subject, doc.full_text);
  const refs = [{ table: 'claudia_documents', id: doc.id }];

  // Pull Pipeline opps mentioned by number in subject/body.
  if (oppNumbers.length) {
    const placeholders = oppNumbers.map(() => '?').join(',');
    const opps = await all(
      env.DB,
      `SELECT * FROM opportunities WHERE number IN (${placeholders}) LIMIT 5`,
      oppNumbers
    );
    out.related.opportunities = opps.map(compactOpp);
    for (const o of opps) refs.push({ table: 'opportunities', id: o.id });
  }

  // Match contacts by sender_email; pull their accounts.
  if (doc.sender_email) {
    const contacts = await all(
      env.DB,
      `SELECT * FROM contacts WHERE LOWER(email) = LOWER(?) LIMIT 5`,
      [doc.sender_email]
    );
    out.related.contacts = contacts.map(compactContact);

    const accountIds = Array.from(new Set(contacts.map((c) => c.account_id).filter(Boolean)));
    if (accountIds.length) {
      const placeholders = accountIds.map(() => '?').join(',');
      const accounts = await all(
        env.DB,
        `SELECT * FROM accounts WHERE id IN (${placeholders}) AND COALESCE(is_archived,0)=0 LIMIT 5`,
        accountIds
      );
      out.related.accounts = accounts.map(compactAccount);
      for (const a of accounts) refs.push({ table: 'accounts', id: a.id });

      // Pull open opps on those accounts (if not already pulled).
      const seenOppIds = new Set(out.related.opportunities.map((o) => o.id));
      const openOpps = await all(
        env.DB,
        `SELECT * FROM opportunities
          WHERE account_id IN (${placeholders})
            AND stage NOT IN ('won','lost','closed')
          ORDER BY updated_at DESC LIMIT 5`,
        accountIds
      );
      for (const o of openOpps) {
        if (seenOppIds.has(o.id)) continue;
        out.related.opportunities.push(compactOpp(o));
        refs.push({ table: 'opportunities', id: o.id });
      }
    }
  }

  // Cross-cluster dedup: find OTHER docs on the same email thread by
  // normalized subject (after stripping RE:/FWD:/Re:/etc.) and include
  // their ids in refs so openActionsForCluster picks up actions
  // already raised on sibling emails. This is the fix for the dedup
  // gap where two emails on the same thread got two independent Hot
  // actions instead of one updated row.
  const threadDocIds = [];
  if (doc.subject) {
    const normalized = String(doc.subject)
      .replace(/^(?:re|fwd?|fw|aw):\s*/gi, '')
      .replace(/^(?:re|fwd?|fw|aw):\s*/gi, '') // double pass for "RE: FWD:"
      .trim();
    if (normalized.length >= 3) {
      const threadDocs = await all(
        env.DB,
        `SELECT id, seq, filename, subject, sender_email, sender_name, email_date, category, retention, summary, full_text, created_at
           FROM claudia_documents
          WHERE user_id = ? AND id <> ?
            AND subject IS NOT NULL
            AND (LOWER(subject) LIKE LOWER(?) OR LOWER(subject) = LOWER(?))
          ORDER BY created_at DESC LIMIT 8`,
        [userId, doc.id, `%${normalized}%`, normalized]
      );
      for (const d of threadDocs) {
        threadDocIds.push(d.id);
        refs.push({ table: 'claudia_documents', id: d.id });
      }
      out.related.docs = threadDocs.map(compactDoc);
    }
  }

  // Sibling docs from same sender (last 6, excluding this one and any
  // thread-siblings already found). Different signal: same person
  // talking on different topics.
  if (doc.sender_email) {
    const seen = new Set([doc.id, ...threadDocIds]);
    const siblings = await all(
      env.DB,
      `SELECT id, seq, filename, subject, sender_email, sender_name, email_date, category, retention, summary, full_text, created_at
         FROM claudia_documents
        WHERE user_id = ? AND LOWER(sender_email) = LOWER(?) AND id <> ?
        ORDER BY created_at DESC LIMIT 6`,
      [userId, doc.sender_email, doc.id]
    );
    for (const s of siblings) {
      if (seen.has(s.id)) continue;
      out.related.docs.push(compactDoc(s));
      // Sender-siblings inform context but don't get added to refs —
      // their actions are about different topics, dedup wouldn't apply.
    }
  }

  // Recent audit for this doc.
  const auditRows = await recentAudit(env, 'document', doc.id, 5);
  out.related.audit_recent = auditRows.map(compactAudit);

  out.open_actions = (await openActionsForCluster(env, userId, refs)).map(compactAction);
  return out;
}

async function enrichOpportunity(env, event, userId) {
  const opp = await one(env.DB, `SELECT * FROM opportunities WHERE id = ?`, [event.refId]);
  if (!opp) return emptyEnrichment(event);

  const out = emptyEnrichment(event);
  out.principal = compactOpp(opp);
  const refs = [{ table: 'opportunities', id: opp.id }];

  if (opp.account_id) {
    const acct = await one(env.DB, `SELECT * FROM accounts WHERE id = ?`, [opp.account_id]);
    if (acct) {
      out.related.accounts = [compactAccount(acct)];
      refs.push({ table: 'accounts', id: acct.id });
    }
  }

  if (opp.primary_contact_id) {
    const c = await one(env.DB, `SELECT * FROM contacts WHERE id = ?`, [opp.primary_contact_id]);
    if (c) out.related.contacts = [compactContact(c)];
  }

  // Activities tied to the opp.
  out.related.activities = (await all(
    env.DB,
    `SELECT * FROM activities WHERE opportunity_id = ? ORDER BY COALESCE(due_at, updated_at) DESC LIMIT 8`,
    [opp.id]
  )).map(compactActivity);

  // Recent quotes on the opp.
  out.related.quotes = (await all(
    env.DB,
    `SELECT * FROM quotes WHERE opportunity_id = ? ORDER BY updated_at DESC LIMIT 5`,
    [opp.id]
  )).map(compactQuote);

  // Docs mentioning the opp number.
  if (opp.number) {
    const like = `%${opp.number}%`;
    out.related.docs = (await all(
      env.DB,
      `SELECT id, seq, filename, subject, sender_email, sender_name, category, retention, summary, full_text, created_at
         FROM claudia_documents
        WHERE user_id = ?
          AND (subject LIKE ? OR full_text LIKE ?)
        ORDER BY created_at DESC LIMIT 6`,
      [userId, like, like]
    )).map(compactDoc);
  }

  out.related.audit_recent = (await recentAudit(env, 'opportunity', opp.id, 5)).map(compactAudit);
  out.open_actions = (await openActionsForCluster(env, userId, refs)).map(compactAction);
  return out;
}

async function enrichAccount(env, event, userId) {
  const acct = await one(env.DB, `SELECT * FROM accounts WHERE id = ?`, [event.refId]);
  if (!acct) return emptyEnrichment(event);

  const out = emptyEnrichment(event);
  out.principal = compactAccount(acct);
  const refs = [{ table: 'accounts', id: acct.id }];

  // Open opps on this account.
  const openOpps = await all(
    env.DB,
    `SELECT * FROM opportunities
      WHERE account_id = ? AND stage NOT IN ('won','lost','closed')
      ORDER BY updated_at DESC LIMIT 5`,
    [acct.id]
  );
  out.related.opportunities = openOpps.map(compactOpp);
  for (const o of openOpps) refs.push({ table: 'opportunities', id: o.id });

  // Recent activities for this account.
  out.related.activities = (await all(
    env.DB,
    `SELECT * FROM activities
      WHERE account_id = ?
      ORDER BY updated_at DESC LIMIT 6`,
    [acct.id]
  )).map(compactActivity);

  // Primary contacts for this account.
  out.related.contacts = (await all(
    env.DB,
    `SELECT * FROM contacts WHERE account_id = ? ORDER BY updated_at DESC LIMIT 5`,
    [acct.id]
  )).map(compactContact);

  // Docs mentioning this account name (limited).
  if (acct.name) {
    const like = `%${acct.name}%`;
    out.related.docs = (await all(
      env.DB,
      `SELECT id, seq, filename, subject, sender_email, sender_name, category, retention, summary, full_text, created_at
         FROM claudia_documents
        WHERE user_id = ?
          AND (subject LIKE ? OR full_text LIKE ?)
        ORDER BY created_at DESC LIMIT 5`,
      [userId, like, like]
    )).map(compactDoc);
  }

  out.related.audit_recent = (await recentAudit(env, 'account', acct.id, 5)).map(compactAudit);
  out.open_actions = (await openActionsForCluster(env, userId, refs)).map(compactAction);
  return out;
}

async function enrichActivity(env, event, userId) {
  const t = await one(env.DB, `SELECT * FROM activities WHERE id = ?`, [event.refId]);
  if (!t) return emptyEnrichment(event);

  // Delegate to the parent enricher when there's a clear parent — gives
  // a richer picture than just the activity itself.
  if (t.opportunity_id) {
    const parentEvent = { ...event, type: 'opportunity.context', refId: t.opportunity_id };
    const parent = await enrichOpportunity(env, parentEvent, userId);
    parent.event = event; // restore original event
    parent.notes.push(`enriched via parent opportunity ${t.opportunity_id} (originating activity ${t.id})`);
    parent.related.activities.unshift(compactActivity(t));
    return parent;
  }
  if (t.account_id) {
    const parentEvent = { ...event, type: 'account.context', refId: t.account_id };
    const parent = await enrichAccount(env, parentEvent, userId);
    parent.event = event;
    parent.notes.push(`enriched via parent account ${t.account_id} (originating activity ${t.id})`);
    parent.related.activities.unshift(compactActivity(t));
    return parent;
  }

  // Standalone activity: minimal envelope.
  const out = emptyEnrichment(event);
  out.principal = compactActivity(t);
  out.related.audit_recent = (await recentAudit(env, 'activity', t.id, 5)).map(compactAudit);
  out.open_actions = (await openActionsForCluster(env, userId, [{ table: 'activities', id: t.id }])).map(compactAction);
  return out;
}

async function enrichContact(env, event, userId) {
  const c = await one(env.DB, `SELECT * FROM contacts WHERE id = ?`, [event.refId]);
  if (!c) return emptyEnrichment(event);
  if (c.account_id) {
    const parentEvent = { ...event, type: 'account.context', refId: c.account_id };
    const parent = await enrichAccount(env, parentEvent, userId);
    parent.event = event;
    parent.notes.push(`enriched via parent account ${c.account_id} (originating contact ${c.id})`);
    parent.related.contacts.unshift(compactContact(c));
    return parent;
  }
  const out = emptyEnrichment(event);
  out.principal = compactContact(c);
  out.related.audit_recent = (await recentAudit(env, 'contact', c.id, 5)).map(compactAudit);
  return out;
}

async function enrichInboxItem(env, event, userId) {
  const item = await one(env.DB, `SELECT * FROM ai_inbox_items WHERE id = ?`, [event.refId]);
  if (!item) return emptyEnrichment(event);
  const out = emptyEnrichment(event);
  out.principal = compactInboxItem(item);

  // Pull entity matches if present (resolved by ai-inbox/process).
  try {
    const matches = await all(
      env.DB,
      `SELECT entity_type, entity_id, confidence FROM ai_inbox_entity_matches
        WHERE inbox_item_id = ? LIMIT 10`,
      [item.id]
    );
    out.notes.push(`${matches.length} prior entity match${matches.length === 1 ? '' : 'es'} on inbox item`);
  } catch {
    // table may not exist in some envs; ignore.
  }

  out.open_actions = (await openActionsForCluster(env, userId, [
    { table: 'ai_inbox_items', id: item.id },
  ])).map(compactAction);
  return out;
}

// ─── Dispatcher ──────────────────────────────────────────────────────

const ENTITY_HANDLERS = {
  // event-type prefix → handler. Dispatch on the part before the dot.
  account: enrichAccount,
  contact: enrichContact,
  opportunity: enrichOpportunity,
  activity: enrichActivity,
  document: enrichDocument,
  claudia_documents: enrichDocument, // legacy alias used by email-ingest
  ai_inbox_items: enrichInboxItem,
  ai_inbox_item: enrichInboxItem,
  // Add more as needed (quote, job).
};

/**
 * Resolve principal + cross-reference for one Claudia event.
 *
 * @param {object} env
 * @param {object} event  { id, type, ref_id|refId, summary, user_id|userId }
 * @returns {Promise<object>} enrichment payload
 */
export async function enrichEvent(env, event) {
  const refId = event.refId ?? event.ref_id ?? null;
  const userId = event.userId ?? event.user_id ?? null;
  const type = event.type ?? '';

  const normalized = { ...event, refId, userId };
  if (!refId || !userId || !type) {
    const out = emptyEnrichment(normalized);
    out.notes.push('missing refId / userId / type — cannot enrich');
    return out;
  }

  const prefix = type.split('.', 1)[0];
  const handler = ENTITY_HANDLERS[prefix];
  if (!handler) {
    const out = emptyEnrichment(normalized);
    out.notes.push(`no enricher for entity prefix '${prefix}' (event type: ${type})`);
    return out;
  }

  try {
    return await handler(env, normalized, userId);
  } catch (err) {
    const out = emptyEnrichment(normalized);
    out.notes.push(`enricher threw: ${err?.message || err}`);
    return out;
  }
}
