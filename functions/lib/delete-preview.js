// functions/lib/delete-preview.js
//
// Helpers that compute "what will be affected" before a destructive
// delete. Powers the cascade-delete confirmation modal (Phase 6).
//
// Each previewXxxDelete returns a JSON-shape that the modal renders:
//   {
//     entity:   { type, id, label },
//     children: [{ kind: 'contacts', count, items: ['name 1', ...] }, ...],
//     // total of all child rows (for the "Delete N records" summary)
//     total_children: <int>,
//   }
//
// Items are capped at 5 per kind for the modal preview list — full
// counts are still surfaced via `count`. The cascade actually happens
// server-side at delete time; these helpers just describe the impact.

import { all, one } from './db.js';

const ITEM_PREVIEW_LIMIT = 5;

/**
 * Account preview. Children are: contacts, opportunities, account
 * addresses, activities (directly attached to the account row, not
 * via opportunities). Opportunities are FK-RESTRICT today (account
 * delete refuses), so cascade=1 will delete them explicitly first;
 * each opp brings its own cascade tree (quotes, jobs, etc.) which
 * we summarize as a top-level number too.
 */
export async function previewAccountDelete(env, accountId) {
  const account = await one(env.DB,
    `SELECT id, name, alias FROM accounts WHERE id = ?`, [accountId]);
  if (!account) return null;

  const [contacts, opps, addresses, activities, jobs, quotes] = await Promise.all([
    all(env.DB, `SELECT id, first_name, last_name FROM contacts WHERE account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id, number, title FROM opportunities WHERE account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM account_addresses WHERE account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM activities WHERE account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
    // Sub-children — counted for the summary but not enumerated
    // (the cascade is implicit through the opportunity chain).
    all(env.DB, `SELECT j.id FROM jobs j JOIN opportunities o ON o.id = j.opportunity_id WHERE o.account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT q.id FROM quotes q JOIN opportunities o ON o.id = q.opportunity_id WHERE o.account_id = ? LIMIT ?`, [accountId, ITEM_PREVIEW_LIMIT]),
  ]);

  const [contactsCount, oppsCount, addressesCount, activitiesCount, jobsCount, quotesCount] = await Promise.all([
    countOne(env.DB, `SELECT COUNT(*) AS n FROM contacts WHERE account_id = ?`, [accountId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM opportunities WHERE account_id = ?`, [accountId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM account_addresses WHERE account_id = ?`, [accountId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM activities WHERE account_id = ?`, [accountId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM jobs j JOIN opportunities o ON o.id = j.opportunity_id WHERE o.account_id = ?`, [accountId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM quotes q JOIN opportunities o ON o.id = q.opportunity_id WHERE o.account_id = ?`, [accountId]),
  ]);

  const children = [];
  if (contactsCount > 0) {
    children.push({
      kind: 'contacts',
      count: contactsCount,
      items: contacts.map((c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'),
    });
  }
  if (oppsCount > 0) {
    children.push({
      kind: 'opportunities',
      count: oppsCount,
      items: opps.map((o) => `${o.number || '(no#)'} · ${o.title || '(untitled)'}`),
    });
  }
  if (quotesCount > 0) {
    children.push({ kind: 'quotes', count: quotesCount, items: [] });
  }
  if (jobsCount > 0) {
    children.push({ kind: 'jobs', count: jobsCount, items: [] });
  }
  if (addressesCount > 0) {
    children.push({ kind: 'addresses', count: addressesCount, items: [] });
  }
  if (activitiesCount > 0) {
    children.push({ kind: 'tasks/notes', count: activitiesCount, items: [] });
  }

  return {
    entity: {
      type: 'account',
      id: account.id,
      label: account.alias || account.name,
    },
    children,
    total_children: children.reduce((s, c) => s + c.count, 0),
  };
}

/**
 * Opportunity preview. Children: quotes, jobs, cost_builds,
 * activities, documents. Jobs are FK-RESTRICT (opp delete refuses);
 * cascade=1 deletes them explicitly. The other kinds CASCADE
 * automatically via the FK definitions, but we still surface them
 * so the user knows.
 */
export async function previewOpportunityDelete(env, oppId) {
  const opp = await one(env.DB,
    `SELECT id, number, title FROM opportunities WHERE id = ?`, [oppId]);
  if (!opp) return null;

  const [quotes, jobs, costBuilds, activities, documents] = await Promise.all([
    all(env.DB, `SELECT id, number, title FROM quotes WHERE opportunity_id = ? LIMIT ?`, [oppId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id, number, title FROM jobs WHERE opportunity_id = ? LIMIT ?`, [oppId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM cost_builds WHERE opportunity_id = ? LIMIT ?`, [oppId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM activities WHERE opportunity_id = ? LIMIT ?`, [oppId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM documents WHERE opportunity_id = ? LIMIT ?`, [oppId, ITEM_PREVIEW_LIMIT]),
  ]);

  const [quotesCount, jobsCount, costBuildsCount, activitiesCount, documentsCount] = await Promise.all([
    countOne(env.DB, `SELECT COUNT(*) AS n FROM quotes WHERE opportunity_id = ?`, [oppId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM jobs WHERE opportunity_id = ?`, [oppId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM cost_builds WHERE opportunity_id = ?`, [oppId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM activities WHERE opportunity_id = ?`, [oppId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE opportunity_id = ?`, [oppId]),
  ]);

  const children = [];
  if (quotesCount > 0) {
    children.push({
      kind: 'quotes',
      count: quotesCount,
      items: quotes.map((q) => `${q.number || '(no#)'} · ${q.title || '(untitled)'}`),
    });
  }
  if (jobsCount > 0) {
    children.push({
      kind: 'jobs',
      count: jobsCount,
      items: jobs.map((j) => `${j.number || '(no#)'} · ${j.title || '(untitled)'}`),
    });
  }
  if (costBuildsCount > 0) {
    children.push({ kind: 'price builds', count: costBuildsCount, items: [] });
  }
  if (activitiesCount > 0) {
    children.push({ kind: 'tasks/notes', count: activitiesCount, items: [] });
  }
  if (documentsCount > 0) {
    children.push({ kind: 'documents', count: documentsCount, items: [] });
  }

  return {
    entity: {
      type: 'opportunity',
      id: opp.id,
      label: `${opp.number || '(no#)'} · ${opp.title || '(untitled)'}`,
    },
    children,
    total_children: children.reduce((s, c) => s + c.count, 0),
  };
}

/**
 * Job preview. Children: change_orders + their child quotes.
 * Documents/activities attached to the job. Most relationships
 * cascade via FK; the exception is change_orders → quotes (each CO
 * can have a quote which we'd need to delete first if cascading).
 */
export async function previewJobDelete(env, jobId) {
  const job = await one(env.DB,
    `SELECT id, number, title FROM jobs WHERE id = ?`, [jobId]);
  if (!job) return null;

  const [changeOrders, activities, documents] = await Promise.all([
    all(env.DB, `SELECT id, number FROM change_orders WHERE job_id = ? LIMIT ?`, [jobId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM activities WHERE job_id = ? LIMIT ?`, [jobId, ITEM_PREVIEW_LIMIT]),
    all(env.DB, `SELECT id FROM documents WHERE job_id = ? LIMIT ?`, [jobId, ITEM_PREVIEW_LIMIT]),
  ]);

  const [changeOrdersCount, activitiesCount, documentsCount] = await Promise.all([
    countOne(env.DB, `SELECT COUNT(*) AS n FROM change_orders WHERE job_id = ?`, [jobId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM activities WHERE job_id = ?`, [jobId]),
    countOne(env.DB, `SELECT COUNT(*) AS n FROM documents WHERE job_id = ?`, [jobId]),
  ]);

  const children = [];
  if (changeOrdersCount > 0) {
    children.push({
      kind: 'change orders',
      count: changeOrdersCount,
      items: changeOrders.map((co) => `${co.number || '(no#)'}`),
    });
  }
  if (activitiesCount > 0) {
    children.push({ kind: 'tasks/notes', count: activitiesCount, items: [] });
  }
  if (documentsCount > 0) {
    children.push({ kind: 'documents', count: documentsCount, items: [] });
  }

  return {
    entity: {
      type: 'job',
      id: job.id,
      label: `${job.number || '(no#)'} · ${job.title || '(untitled)'}`,
    },
    children,
    total_children: children.reduce((s, c) => s + c.count, 0),
  };
}

async function countOne(db, sql, params) {
  const r = await one(db, sql, params);
  return Number(r?.n || 0);
}
