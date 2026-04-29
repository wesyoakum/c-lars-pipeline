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

// ----- shared section builders -------------------------------------

// Build an Account section: resolve the org name against existing
// accounts, then either compose a "matched + push_candidates"
// section (only emit candidates when proposed differs) or a
// "proposed_new + push_candidates" section (emit all non-empty
// extracted fields, all checked by default).
//
// Returns { matched, proposed_new, push_candidates } or null when
// there's neither an org name nor any extracted org detail to act on.
async function buildAccountSection(env, orgDetail, orgName) {
  if (!orgName && !orgDetail) return null;

  // Resolve org → existing account
  let accountMatch = null;
  if (orgName) {
    const candidates = await resolveEntities(env.DB, {
      people: [],
      organizations: [orgName],
    });
    const top = candidates.find((c) => c.mention_kind === 'organization');
    // score >= 80 = exact or prefix match (see entity-resolver.js)
    if (top && top.score >= 80) {
      accountMatch = await one(env.DB,
        `SELECT id, name, alias, segment, phone, website
           FROM accounts WHERE id = ?`,
        [top.ref_id]);
    }
  }

  const pushCandidates = [];
  if (!accountMatch && orgDetail) {
    // NEW account: emit every non-empty extracted field as a candidate
    // (checked by default — user can deselect anything they don't want).
    if (orgDetail.phone) {
      pushCandidates.push({
        field: 'phone', current: '', proposed: orgDetail.phone,
        conflict: false, checked: true,
      });
    }
    if (orgDetail.website) {
      pushCandidates.push({
        field: 'website', current: '', proposed: orgDetail.website,
        conflict: false, checked: true,
      });
    }
    if (orgDetail.address) {
      pushCandidates.push({
        field: 'address', current: '', proposed: orgDetail.address,
        conflict: false, checked: true,
        address_physical: true, address_billing: false,
      });
    }
  }
  if (accountMatch && orgDetail) {
    // EXISTING account: only emit candidates where the proposed value
    // differs from the existing one. Auto-check empty-target rows;
    // unchecked-by-default for conflicts so the user has to opt in.
    if (orgDetail.phone) {
      const matchPhone = normPhone(accountMatch.phone) === normPhone(orgDetail.phone);
      if (!matchPhone) {
        pushCandidates.push({
          field: 'phone',
          current: accountMatch.phone || '',
          proposed: orgDetail.phone,
          conflict: !!accountMatch.phone,
          checked: !accountMatch.phone,
        });
      }
    }
    if (orgDetail.website) {
      const matchUrl = normUrl(accountMatch.website) === normUrl(orgDetail.website);
      if (!matchUrl) {
        pushCandidates.push({
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
        pushCandidates.push({
          field: 'address',
          current: existing.length > 0 ? `${existing.length} existing address(es)` : '',
          proposed: orgDetail.address,
          conflict: existing.length > 0,
          checked: existing.length === 0,
          address_physical: existing.length === 0,
          address_billing: false,
        });
      }
    }
  }

  const proposedNew = (!accountMatch && orgName) ? {
    name: orgName,
    alias: deriveAlias(orgName),
    phone: orgDetail?.phone || '',
    website: orgDetail?.website || '',
    address: orgDetail?.address || '',
  } : null;

  // Empty section (no match, no proposal, no candidates) → null
  if (!accountMatch && !proposedNew && pushCandidates.length === 0) return null;

  return {
    matched: accountMatch ? {
      id: accountMatch.id,
      name: accountMatch.name,
      alias: accountMatch.alias,
    } : null,
    proposed_new: proposedNew,
    push_candidates: pushCandidates,
  };
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

  // ---- Account section ----
  const accountSection = await buildAccountSection(env, orgDetail, orgName);
  const accountMatchId = accountSection?.matched?.id || null;

  // ---- Resolve person against contacts at the matched account ----
  let contactMatch = null;
  if (personName && accountMatchId) {
    const rows = await all(env.DB,
      `SELECT id, first_name, last_name, title, email, phone, mobile,
              linkedin_url, linkedin_url_source
         FROM contacts WHERE account_id = ?`,
      [accountMatchId]);
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
    account: accountSection,
    contact: {
      matched: contactMatch ? {
        id: contactMatch.id,
        first_name: contactMatch.first_name,
        last_name: contactMatch.last_name,
        account_id: accountMatchId,
      } : null,
      proposed_new: proposedNewContact,
      push_candidates: contactPushCandidates,
    },
  };
}

// ----- account-wizard planner --------------------------------------
//
// Just dedup detection on the org. No contact section. The review
// screen then shows: "Looks like you have Acme Corp (existing)" with
// any push candidates for empty/different fields, OR "Will create
// Acme Corp" with checkboxes for each captured field.

async function planAccount(env, extracted) {
  const orgDetail = (extracted?.organizations_detail && extracted.organizations_detail[0]) || null;
  const orgName = (orgDetail && orgDetail.name)
    || (extracted?.organizations && extracted.organizations[0])
    || '';

  const accountSection = await buildAccountSection(env, orgDetail, orgName);
  if (!accountSection) return null;

  return {
    account: accountSection,
  };
}

// ----- opportunity-wizard planner ----------------------------------
//
// Phase 5b-2: just dedup the account. The opp wizard's steps already
// handle title/type/value/description (with title and description
// prefilled from extraction via applyExtraction); the cascade simply
// resolves the account up front so the user doesn't have to type-
// search for it. After the user confirms the account, the executor
// creates / pushes account fields and the engine transitions to the
// standard step UI to finish the opp creation (type, value, etc.).

async function planOpportunity(env, extracted) {
  const orgDetail = (extracted?.organizations_detail && extracted.organizations_detail[0]) || null;
  const orgName = (orgDetail && orgDetail.name)
    || (extracted?.organizations && extracted.organizations[0])
    || '';

  const accountSection = await buildAccountSection(env, orgDetail, orgName);
  if (!accountSection) return null;

  return {
    account: accountSection,
    // No contact / opportunity sections — those happen in the
    // standard step UI after the cascade resolves the account.
    continue_to_steps: true,
  };
}

// ----- quote-wizard planner ----------------------------------------
//
// Phase 5b-3: same shape as opportunity — dedup the account, then
// hand off to the step UI where the user picks the opportunity and
// quote_type. Title and description are prefilled via the wizard's
// existing applyExtraction.

async function planQuote(env, extracted) {
  const orgDetail = (extracted?.organizations_detail && extracted.organizations_detail[0]) || null;
  const orgName = (orgDetail && orgDetail.name)
    || (extracted?.organizations && extracted.organizations[0])
    || '';

  const accountSection = await buildAccountSection(env, orgDetail, orgName);
  if (!accountSection) return null;

  return {
    account: accountSection,
    continue_to_steps: true,
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

  if (wizardKey === 'account') {
    const plan = await planAccount(env, extracted);
    if (!plan) return json({ ok: true, plan: null });
    plan.ai_inbox_entry_id = aiInboxEntryId;
    return json({ ok: true, plan });
  }

  if (wizardKey === 'opportunity') {
    const plan = await planOpportunity(env, extracted);
    if (!plan) return json({ ok: true, plan: null });
    plan.ai_inbox_entry_id = aiInboxEntryId;
    return json({ ok: true, plan });
  }

  if (wizardKey === 'quote') {
    const plan = await planQuote(env, extracted);
    if (!plan) return json({ ok: true, plan: null });
    plan.ai_inbox_entry_id = aiInboxEntryId;
    return json({ ok: true, plan });
  }

  // Other wizards: not yet planned. Return null so the engine just
  // falls through to the standard step UI with prefilled answers.
  return json({ ok: true, plan: null });
}
