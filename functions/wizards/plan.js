// functions/wizards/plan.js
//
// POST /wizards/plan
//
// Smart-start cascade planner. Takes the AI Inbox extraction result
// (already produced by /ai-inbox/new) and computes what the wizard
// would create / update / push, with conflict detection against
// existing CRM records. The client renders this as a Review screen
// where the user toggles individual operations before hitting Confirm.
//
// Confirm hits /wizards/execute with the (possibly user-edited) plan.
//
// Body (JSON):
//   {
//     wizard_key: 'contact' | 'account' | 'opportunity' | 'quote' | 'task',
//     extracted: <AI Inbox extraction>,
//     ai_inbox_entry_id?: '<uuid>',
//   }
//
// Response (contact-shaped — Phase 5a):
//   {
//     ok: true,
//     plan: {
//       account: {
//         matched: { id, name, alias, phone, website, segment } | null,
//         proposed_new: { name, alias } | null,
//         push_candidates: [
//           { field, current, proposed, conflict, checked }
//         ],
//       },
//       contact: {
//         matched: { id, first_name, last_name, account_id, ... } | null,
//         proposed_new: { first_name, last_name, title, email, phone, linkedin_url } | null,
//         push_candidates: [
//           { field, current, proposed, conflict, checked }
//         ],
//       },
//       ai_inbox_entry_id: <uuid|null>,
//     },
//   }
//
// Other wizard_key values return { ok: true, plan: null } (no cascade
// planning yet — the wizard falls through to the normal step UI).

import { all, one } from '../lib/db.js';
import { resolveEntities } from '../lib/entity-resolver.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ----- normalizers (mirror existing patterns elsewhere) -------------

function normPhone(s) {
  let d = String(s || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function normUrl(s) {
  let v = String(s || '').trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/^(www\.|m\.)/, '');
  v = v.split('?')[0].split('#')[0];
  v = v.replace(/\/+$/, '');
  return v;
}

function normAddress(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[.,]/g, '')
    .trim()
    .toLowerCase();
}

function deriveAlias(name) {
  if (!name) return null;
  return String(name)
    .replace(/[,.]/g, '')
    .replace(/\b(inc|llc|corp|corporation|company|co|ltd|limited|gmbh|sa|ag|nv|bv|plc|llp|lp)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function splitFullName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { first_name: '', last_name: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// ----- contact-wizard planner --------------------------------------

async function planContact(env, extracted) {
  const personDetail = (extracted?.people_detail && extracted.people_detail[0]) || null;
  const personName = (personDetail && personDetail.name)
    || (extracted?.people && extracted.people[0])
    || '';

  const orgDetail = (extracted?.organizations_detail && extracted.organizations_detail[0]) || null;
  const orgName = (orgDetail && orgDetail.name)
    || (extracted?.organizations && extracted.organizations[0])
    || '';

  // ---- Resolve org against accounts ----
  let accountMatch = null;
  if (orgName) {
    const candidates = await resolveEntities(env.DB, {
      people: [],
      organizations: [orgName],
    });
    const top = candidates.find((c) => c.mention_kind === 'organization');
    // Threshold for "this is the same account" — score >= 100 (exact)
    // OR score >= 80 (prefix) if the gap to the next candidate is wide.
    if (top && top.score >= 80) {
      accountMatch = await one(env.DB,
        `SELECT id, name, alias, segment, phone, website
           FROM accounts WHERE id = ?`,
        [top.ref_id]);
    }
  }

  // ---- Build account push candidates ----
  // For NEW accounts: emit one row per non-empty extracted field
  // (phone / website / address) so the user can deselect anything
  // they don't want included on creation. current='' (nothing exists
  // yet), checked=true by default.
  // For MATCHED accounts: only emit rows where the proposed value
  // differs from the existing one (and only check rows where target
  // is empty).
  const accountPushCandidates = [];
  if (!accountMatch && orgDetail) {
    if (orgDetail.phone) {
      accountPushCandidates.push({
        field: 'phone', current: '', proposed: orgDetail.phone,
        conflict: false, checked: true,
      });
    }
    if (orgDetail.website) {
      accountPushCandidates.push({
        field: 'website', current: '', proposed: orgDetail.website,
        conflict: false, checked: true,
      });
    }
    if (orgDetail.address) {
      accountPushCandidates.push({
        field: 'address', current: '', proposed: orgDetail.address,
        conflict: false, checked: true,
      });
    }
  }
  if (accountMatch && orgDetail) {
    if (orgDetail.phone) {
      const matchPhone = normPhone(accountMatch.phone) === normPhone(orgDetail.phone);
      if (!matchPhone) {
        accountPushCandidates.push({
          field: 'phone',
          current: accountMatch.phone || '',
          proposed: orgDetail.phone,
          conflict: !!accountMatch.phone,
          checked: !accountMatch.phone,  // only auto-check when target is empty
        });
      }
    }
    if (orgDetail.website) {
      const matchUrl = normUrl(accountMatch.website) === normUrl(orgDetail.website);
      if (!matchUrl) {
        accountPushCandidates.push({
          field: 'website',
          current: accountMatch.website || '',
          proposed: orgDetail.website,
          conflict: !!accountMatch.website,
          checked: !accountMatch.website,
        });
      }
    }
    if (orgDetail.address) {
      const existing = await all(env.DB,
        `SELECT id, address FROM account_addresses WHERE account_id = ?`,
        [accountMatch.id]);
      const dup = existing.some((a) => normAddress(a.address) === normAddress(orgDetail.address));
      if (!dup) {
        accountPushCandidates.push({
          field: 'address',
          // Show the "current" as a summary of what's already there,
          // since address adds (rather than overwrites) — there's no
          // real "current" to replace.
          current: existing.length > 0 ? `${existing.length} existing address(es)` : '',
          proposed: orgDetail.address,
          conflict: existing.length > 0,
          checked: existing.length === 0,
        });
      }
    }
  }

  // ---- Resolve person against contacts at the matched account ----
  let contactMatch = null;
  if (personName && accountMatch) {
    const rows = await all(env.DB,
      `SELECT id, first_name, last_name, title, email, phone, mobile,
              linkedin_url, linkedin_url_source
         FROM contacts WHERE account_id = ?`,
      [accountMatch.id]);
    const target = personName.toLowerCase().trim();
    contactMatch = rows.find((c) => {
      const full = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase();
      return full === target;
    }) || null;
    // Fallback: if email is in the extraction, also try email-match
    // against contacts at this account — handles "Bob Smith" vs "Robert Smith"
    if (!contactMatch && personDetail?.email) {
      const e = normEmail(personDetail.email);
      contactMatch = rows.find((c) => normEmail(c.email) === e) || null;
    }
  }

  // ---- Build contact push candidates ----
  // Same dual mode as the account section: NEW contacts get a row per
  // non-empty extracted field; MATCHED contacts only get rows where
  // the value differs.
  const contactPushCandidates = [];
  if (!contactMatch && personDetail) {
    if (personDetail.title) {
      contactPushCandidates.push({
        field: 'title', current: '', proposed: personDetail.title,
        conflict: false, checked: true,
      });
    }
    if (personDetail.email) {
      contactPushCandidates.push({
        field: 'email', current: '', proposed: personDetail.email,
        conflict: false, checked: true,
      });
    }
    if (personDetail.phone) {
      contactPushCandidates.push({
        field: 'phone', current: '', proposed: personDetail.phone,
        conflict: false, checked: true,
      });
    }
    if (personDetail.linkedin) {
      contactPushCandidates.push({
        field: 'linkedin_url', current: '', proposed: personDetail.linkedin,
        conflict: false, checked: true,
      });
    }
  }
  if (contactMatch && personDetail) {
    if (personDetail.title) {
      const same = (contactMatch.title || '').trim().toLowerCase()
        === personDetail.title.trim().toLowerCase();
      if (!same) {
        contactPushCandidates.push({
          field: 'title',
          current: contactMatch.title || '',
          proposed: personDetail.title,
          conflict: !!contactMatch.title,
          checked: !contactMatch.title,
        });
      }
    }
    if (personDetail.email) {
      const same = normEmail(contactMatch.email) === normEmail(personDetail.email);
      if (!same) {
        contactPushCandidates.push({
          field: 'email',
          current: contactMatch.email || '',
          proposed: personDetail.email,
          conflict: !!contactMatch.email,
          checked: !contactMatch.email,
        });
      }
    }
    if (personDetail.phone) {
      const same = normPhone(contactMatch.phone) === normPhone(personDetail.phone)
        || normPhone(contactMatch.mobile) === normPhone(personDetail.phone);
      if (!same) {
        contactPushCandidates.push({
          field: 'phone',
          current: contactMatch.phone || '',
          proposed: personDetail.phone,
          conflict: !!contactMatch.phone,
          checked: !contactMatch.phone,
        });
      }
    }
    if (personDetail.linkedin) {
      const same = normUrl(contactMatch.linkedin_url) === normUrl(personDetail.linkedin);
      if (!same) {
        contactPushCandidates.push({
          field: 'linkedin_url',
          current: contactMatch.linkedin_url || '',
          proposed: personDetail.linkedin,
          conflict: !!contactMatch.linkedin_url,
          checked: !contactMatch.linkedin_url,
        });
      }
    }
  }

  // ---- Compose plan ----
  const proposedNewAccount = (!accountMatch && orgName) ? {
    name: orgName,
    alias: deriveAlias(orgName),
    phone: orgDetail?.phone || '',
    website: orgDetail?.website || '',
    address: orgDetail?.address || '',
  } : null;

  const personParts = splitFullName(personName);
  const proposedNewContact = (!contactMatch && (personParts.first_name || personParts.last_name)) ? {
    first_name: personParts.first_name,
    last_name: personParts.last_name,
    title: personDetail?.title || '',
    email: personDetail?.email || '',
    phone: personDetail?.phone || '',
    linkedin_url: personDetail?.linkedin || '',
  } : null;

  return {
    account: {
      matched: accountMatch ? {
        id: accountMatch.id,
        name: accountMatch.name,
        alias: accountMatch.alias,
      } : null,
      proposed_new: proposedNewAccount,
      push_candidates: accountPushCandidates,
    },
    contact: {
      matched: contactMatch ? {
        id: contactMatch.id,
        first_name: contactMatch.first_name,
        last_name: contactMatch.last_name,
        account_id: accountMatch?.id || null,
      } : null,
      proposed_new: proposedNewContact,
      push_candidates: contactPushCandidates,
    },
  };
}

// --------------------------------------------------------------------

export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const wizardKey = String(body?.wizard_key || '').trim();
  const extracted = body?.extracted || null;
  const aiInboxEntryId = body?.ai_inbox_entry_id || null;

  if (!extracted) {
    // No extraction yet → no plan. Wizard falls through to manual flow.
    return json({ ok: true, plan: null });
  }

  if (wizardKey === 'contact') {
    const plan = await planContact(env, extracted);
    plan.ai_inbox_entry_id = aiInboxEntryId;
    return json({ ok: true, plan });
  }

  // Other wizards: not yet planned. Return null so the engine just
  // falls through to the standard step UI with prefilled answers.
  return json({ ok: true, plan: null });
}
