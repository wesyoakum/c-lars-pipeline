// functions/lib/filename-templates.js
//
// Render customizable filenames for generated documents (quote PDFs,
// Word docs, order confirmations, NTPs, etc.). Users edit the templates
// inline on the Templates list page (/documents/templates); this helper
// does the `{token}` substitution at generation time.
//
// Keys match template catalog entries (quote-service, quote-spares,
// oc-eps, ntp, …) so each template row has one filename convention
// that covers both its PDF and DOCX renderings — the generate handler
// appends the correct extension at download time.
//
// Tokens that aren't in the context render as empty strings — so an
// unset `{accountAlias}` just disappears from the filename rather
// than leaving the literal `{accountAlias}` text. Characters that
// common filesystems reject (slashes, colons, quotes, etc.) are
// stripped after substitution so users can write natural templates
// without worrying about edge cases in account or quote titles.

import { one, all } from './db.js';

/** Characters that Windows / macOS / Linux filesystems reject. */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** Collapse repeated whitespace and trim, after substitution. */
function cleanupFilename(name) {
  return name
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render a filename template by substituting `{token}` placeholders
 * with values from `context`. Missing / nullish tokens render empty.
 *
 * @param {string} template — e.g. "C-LARS Quote {quoteNumber}.pdf"
 * @param {Record<string, string|number|null>} context — token map
 * @returns {string} cleaned filename, or '' when template is empty
 */
export function renderFilenameTemplate(template, context) {
  if (!template) return '';
  const rendered = template.replace(/\{(\w+)\}/g, (_match, token) => {
    const value = context?.[token];
    if (value == null) return '';
    return String(value);
  });
  return cleanupFilename(rendered);
}

/**
 * Load a single template by key. Returns `fallback` if the key is
 * missing from the table — useful so generate handlers always have
 * something to work with even if the row is deleted.
 */
export async function getFilenameTemplate(env, key, fallback = '') {
  const row = await one(
    env.DB,
    'SELECT template FROM filename_templates WHERE key = ?',
    [key]
  );
  const tpl = (row?.template || '').trim();
  return tpl || fallback;
}

/** List every template row for the admin page. */
export async function listFilenameTemplates(env) {
  return all(
    env.DB,
    'SELECT key, template, description, updated_at FROM filename_templates ORDER BY key'
  );
}

/**
 * Build the token context for a quote-based filename. Pulls the
 * pieces the generate handlers already have on hand (the raw quote
 * row + a few associated fields) and returns a flat token map.
 *
 * Exposed tokens: see FILENAME_TOKENS below for the full list.
 */
export function buildQuoteFilenameContext({
  quote,
  accountName,
  accountAlias,
  opportunityNumber,
  opportunityTitle,
}) {
  const rev = quote?.revision || '';
  const revisionSuffix = rev && rev !== 'v1' ? `-${rev}` : '';
  const today = new Date().toISOString().slice(0, 10);

  return {
    quoteNumber:       quote?.number || '',
    revision:          rev,
    revisionSuffix,
    quoteTitle:        quote?.title || '',
    accountName:       accountName || '',
    accountAlias:      accountAlias || '',
    opportunityNumber: opportunityNumber || '',
    opportunityTitle:  opportunityTitle || '',
    ocNumber:          '',
    ntpNumber:         '',
    jobNumber:         '',
    date:              today,
  };
}

/**
 * Build the token context for a job-based filename (OC / NTP).
 * Used by future OC and NTP generators. Missing fields render as
 * empty strings so the template can be shared across job types.
 */
export function buildJobFilenameContext({
  job,
  accountName,
  accountAlias,
  opportunityNumber,
  opportunityTitle,
  quoteNumber,
}) {
  const today = new Date().toISOString().slice(0, 10);

  return {
    quoteNumber:       quoteNumber || '',
    revision:          '',
    revisionSuffix:    '',
    quoteTitle:        '',
    accountName:       accountName || '',
    accountAlias:      accountAlias || '',
    opportunityNumber: opportunityNumber || '',
    opportunityTitle:  opportunityTitle || '',
    ocNumber:          job?.oc_number || '',
    ntpNumber:         job?.ntp_number || '',
    jobNumber:         job?.number || '',
    date:              today,
  };
}

/**
 * Reference list of tokens for the admin UI. Keep in sync with
 * the context builders above so users have an accurate cheat
 * sheet when editing templates.
 */
export const FILENAME_TOKENS = [
  { token: 'quoteNumber',       label: 'Quote number (e.g. 25-00042)' },
  { token: 'revision',          label: 'Revision only (e.g. v2)' },
  { token: 'revisionSuffix',    label: 'Revision with dash, empty for v1 (e.g. "-v2")' },
  { token: 'quoteTitle',        label: 'Quote title' },
  { token: 'accountName',       label: 'Customer account name' },
  { token: 'accountAlias',      label: 'Customer short alias' },
  { token: 'opportunityNumber', label: 'Opportunity number' },
  { token: 'opportunityTitle',  label: 'Opportunity title' },
  { token: 'ocNumber',          label: 'OC number (OC / NTP templates)' },
  { token: 'ntpNumber',         label: 'NTP number (NTP template)' },
  { token: 'jobNumber',         label: 'Job number (OC / NTP templates)' },
  { token: 'date',              label: 'Today, YYYY-MM-DD' },
];

/**
 * Sample context used to drive live filename previews in the
 * Templates list UI. Mirrors what a real quote/job would provide
 * so users can see what their convention will look like.
 */
export const FILENAME_PREVIEW_CONTEXT = {
  quoteNumber:       'Q25-00042-1',
  revision:          'v2',
  revisionSuffix:    '-v2',
  quoteTitle:        'Q2 Spares Refresh',
  accountName:       'Helix Robotics',
  accountAlias:      'Helix',
  opportunityNumber: '25-00042',
  opportunityTitle:  'Helix robot spares',
  ocNumber:          'OC-25-0042',
  ntpNumber:         'NTP-25-0042',
  jobNumber:         'J25-00042',
  date:              new Date().toISOString().slice(0, 10),
};
