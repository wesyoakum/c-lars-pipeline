// functions/lib/claudia-categorize.js
//
// One-shot categorizer for documents Wes drops into Claudia's drop-zone.
// Runs on Haiku (fast + cheap), takes filename + content_type + a chunk
// of the extracted text, returns one category from a small fixed enum
// or null if unsure.
//
// Called from functions/sandbox/assistant/documents/index.js after the
// extraction step succeeds. Failures are non-fatal — the row's
// `category` column simply stays NULL and Claudia (or Wes) can fill it
// in later via set_document_category.
//
// The category column ships under the `set_document_category`
// permission's catalog entry but the auto-categorize-on-upload flow
// is NOT gated by it — Wes always wants the auto-label even when the
// manual write tool is off, because reading is free and labels are
// purely informational. Wes flips set_document_category to control
// whether CLAUDIA can change them after the fact.

import { messagesJson } from './anthropic.js';

const CATEGORIZE_MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
const CATEGORIZE_MAX_TEXT_CHARS = 4000;

/**
 * Allowed category values. Kept tight so the column is actually useful
 * for filtering. New values: add here AND mention in the prompt below.
 */
export const DOCUMENT_CATEGORIES = [
  'rfq',           // Request for Quote — inbound spec / pricing request
  'spec',          // Spec sheet, datasheet, technical drawing
  'quote',         // A quote we drafted/sent OR a competitor quote
  'po',            // Purchase order
  'contract',      // Contract / agreement / NDA / terms
  'email',         // Email file (.eml/.mbox)
  'meeting_note',  // Meeting notes / voice memo transcript / minutes
  'contact_list',  // Contact CSV / vCard / address export
  'marketing',     // Brochure / one-pager / capability statement
  'badge',         // Conference / trade-show badge photo (with visible event branding)
  'headshot',      // Professional portrait photo of one person — bio / website / org chart use
  'business_card', // Business card photo
  'invoice',       // Invoice (inbound or outbound)
  'spreadsheet',   // Generic data spreadsheet that doesn't fit above
  'other',         // Catch-all
];

const ALLOWED = new Set(DOCUMENT_CATEGORIES);

/**
 * Pick a category for one document. Returns one of DOCUMENT_CATEGORIES,
 * or null if Claude said "unsure" / errored / the input is too thin to
 * judge. Caller is responsible for writing the result to
 * claudia_documents.category.
 *
 * Skips the LLM call entirely when:
 *   - text is empty (extraction failed) AND filename is uninformative
 *   - filename heuristic gives a high-confidence guess (saves a call)
 */
export async function categorizeDocument(env, { filename, contentType, text, parentSubject }) {
  const heuristic = heuristicCategory(filename, contentType, parentSubject);
  if (heuristic) return heuristic;

  const trimmedText = String(text || '').slice(0, CATEGORIZE_MAX_TEXT_CHARS).trim();
  if (!trimmedText && !filename && !parentSubject) return null;

  const system = [
    'You categorize one document for an offshore-engineering company\'s sales assistant.',
    `Pick the single best category from this list: ${DOCUMENT_CATEGORIES.join(', ')}.`,
    '',
    'Definitions:',
    '- rfq: Request for Quote / RFP / RFI — inbound spec or pricing request from a customer.',
    '- spec: Technical spec sheet, datasheet, drawing, capability sheet for a product.',
    '- quote: A QUOTE document — could be one we sent or one received from a competitor / supplier.',
    '- po: Purchase Order document.',
    '- contract: Contract, agreement, NDA, terms-and-conditions.',
    '- email: An email file (.eml / .mbox).',
    '- meeting_note: Meeting notes, voice memo transcript, call summary, minutes.',
    '- contact_list: A spreadsheet/CSV/vCard of contacts (people + emails / phones).',
    '- marketing: Brochure, one-pager, marketing collateral, capability statement.',
    '- badge: Conference / trade-show badge photo. ONLY when the image clearly shows a badge / lanyard / name-tag with a visible event name, conference branding, or booth number. A plain photo of a person without a visible badge is NOT a badge — it\'s a headshot.',
    '- headshot: Professional portrait photo of one person, suitable for a bio / website / org chart. Generic plain-background photo of a face. When the parent email subject says "head shot", "headshot", "portrait", "bio photo", or similar — this is the right category.',
    '- business_card: Business card photo — clearly shows a card layout with name + title + company.',
    '- invoice: Invoice document (inbound bill or outbound charge).',
    '- spreadsheet: Generic data spreadsheet with no obvious sales / contact / pricing context.',
    '- other: Anything that doesn\'t cleanly fit above.',
    '',
    'Output STRICT JSON, no prose around it: { "category": "<one of the list>", "confidence": "high"|"medium"|"low" }.',
    'If you are not confident enough to commit, output { "category": null, "confidence": "low" } — that is BETTER than guessing wrong.',
  ].join('\n');

  const userBlob = JSON.stringify({
    filename: filename || null,
    content_type: contentType || null,
    parent_email_subject: parentSubject || null,  // populated when this is an attachment of an .eml
    text_excerpt: trimmedText,
  });

  let json;
  try {
    const result = await messagesJson(env, {
      system,
      user: userBlob,
      model: env.CLAUDIA_CATEGORIZE_MODEL || CATEGORIZE_MODEL_DEFAULT,
      maxTokens: 60,
      temperature: 0,
    });
    json = result.json;
  } catch (err) {
    console.error('[claudia-categorize] model call failed:', err?.message || err);
    return null;
  }

  const cat = String(json?.category || '').trim().toLowerCase();
  if (!cat || cat === 'null') return null;
  if (!ALLOWED.has(cat)) return null;
  // Discard low-confidence guesses; better to leave the column NULL.
  const conf = String(json?.confidence || '').toLowerCase();
  if (conf === 'low') return null;
  return cat;
}

/**
 * Cheap pre-LLM heuristic. Catches the obvious cases (extension or
 * filename keyword) so we don't pay for a Claude call when a
 * regex would work. Returns null when there's no strong signal.
 *
 * Intentionally conservative — only matches when the extension or
 * keyword is unambiguous. Anything fuzzy goes through the LLM.
 */
function heuristicCategory(filename, contentType, parentSubject) {
  const fn = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const ps = String(parentSubject || '').toLowerCase();

  // Parent-email-subject heuristics — attachment carries forward the
  // parent's intent. "Fw: Head shot" → the attached PNG is a headshot,
  // not a generic image.
  if (ps && (/\bhead[\s_-]?shot\b/.test(ps) || /\bportrait\b/.test(ps) || /\bbio[\s_-]?photo\b/.test(ps))) {
    if (ct.startsWith('image/')) return 'headshot';
  }
  if (ps && /\bbusiness[\s_-]?card\b/.test(ps) && ct.startsWith('image/')) return 'business_card';
  if (ps && /\bbadge\b/.test(ps) && ct.startsWith('image/')) return 'badge';

  if (ct === 'message/rfc822' || fn.endsWith('.eml')) return 'email';
  if (fn.endsWith('.mbox') || ct === 'application/mbox') return 'email';
  if (fn.endsWith('.vcf') || fn.endsWith('.vcard')) return 'contact_list';

  // Filename keywords — strict matches only.
  if (/\brfq\b/.test(fn)) return 'rfq';
  if (/\bquote\b/.test(fn) && !/quotex|quoter/.test(fn)) return 'quote';
  if (/\bpurchase[\s_-]?order\b/.test(fn) || /\bpo[-_]?\d/.test(fn)) return 'po';
  if (/\binvoice\b/.test(fn) || /\binv[-_]?\d/.test(fn)) return 'invoice';
  if (/\bnda\b/.test(fn) || /\bcontract\b/.test(fn) || /\bagreement\b/.test(fn)) return 'contract';
  if (/\b(contacts?|address(es)?\s?book|people)\b/.test(fn) && (fn.endsWith('.csv') || fn.endsWith('.tsv'))) return 'contact_list';
  if (/\bbusiness[\s_-]?card\b/.test(fn)) return 'business_card';
  if (/\bbadge\b/.test(fn)) return 'badge';
  if (/\bhead[\s_-]?shot\b/.test(fn) || /\bportrait\b/.test(fn) || /\bbio[\s_-]?photo\b/.test(fn)) return 'headshot';
  if (/\bbrochure\b/.test(fn) || /\bone[-_]?pager\b/.test(fn) || /\bcapabilit/.test(fn)) return 'marketing';
  if (/\b(meeting|minutes|notes?|call[-_]?notes?|voice[-_]?memo)\b/.test(fn)) return 'meeting_note';

  return null;
}
