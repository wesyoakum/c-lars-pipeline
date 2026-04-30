// functions/lib/quote-line-polish.js
//
// AI-powered polish pass for a single quote line. Takes the line's
// three free-text fields (title, description, line_notes) plus the
// surrounding context (account, opportunity, quote type) and returns
// a polished triple suitable for a customer-facing quote PDF.
//
// Single Anthropic call returns strict JSON. Empty fields stay empty
// (the prompt is explicit on that) so the user can scope the polish
// to whatever they've filled in.
//
// Domain terms (VOO, EPS, ROV, OC, RFQ, etc.) are preserved verbatim
// — the prompt mirrors the rule from functions/ai-inbox/prompts.js.

import { messagesJson } from './anthropic.js';

/**
 * Polish the three free-text fields on a quote line. Returns
 *   { title, description, line_notes }
 * with any field that came in empty staying empty.
 *
 * `ctx` shape:
 *   {
 *     title:        string,
 *     description:  string,
 *     line_notes:   string,
 *     part_number:  string,        // not polished, just context
 *     account_name: string,
 *     opp_title:    string,
 *     opp_number:   string,
 *     quote_type:   string,        // 'spares' | 'eps' | 'service' | …
 *   }
 */
export async function polishLine(env, ctx) {
  const has = (s) => typeof s === 'string' && s.trim().length > 0;
  const allEmpty = !has(ctx.title) && !has(ctx.description) && !has(ctx.line_notes);
  if (allEmpty) {
    return { title: '', description: '', line_notes: '' };
  }

  const system = SYSTEM_PROMPT;
  const userMsg = buildUserMessage(ctx);

  const result = await messagesJson(env, {
    system,
    messages: [{ role: 'user', content: userMsg }],
    // Cheap-tier model — this is a copy-edit task, not extraction.
    model: env.QUOTE_POLISH_MODEL || 'claude-haiku-4-5',
    maxTokens: 800,
    temperature: 0.2,
  });

  const j = result.json || {};
  return {
    title:       sanitizeField(j.title,       ctx.title),
    description: sanitizeField(j.description, ctx.description),
    line_notes:  sanitizeField(j.line_notes,  ctx.line_notes),
  };
}

function sanitizeField(polished, original) {
  // If the original was empty, return empty regardless of what the
  // model produced. (Belt + suspenders alongside the prompt rule.)
  if (typeof original !== 'string' || original.trim() === '') return '';
  if (typeof polished !== 'string') return original;
  const trimmed = polished.trim();
  if (!trimmed) return original;
  // Cap to a reasonable max — guards against a runaway response.
  return trimmed.slice(0, 1500);
}

const SYSTEM_PROMPT = `You polish quote line items for a B2B engineering company (C-LARS) writing customer-facing quote documents.

Return strict JSON with this exact shape:
{
  "title":       "string — short product/service name (under 60 chars)",
  "description": "string — 1-2 sentence customer-facing description",
  "line_notes":  "string — concise notes / caveats / lead-time / warranty"
}

Rules:
- Preserve technical specifics (load capacity, depth ratings, voltages, dimensions, etc.) verbatim — never round, drop, or invent values.
- Preserve industry / domain terms exactly: VOO, vessel of opportunity, EPS, ROV, OC (Order Confirmation), RFQ, ARO, IM&OH, FAT, etc. Don't expand acronyms unless the source already does.
- The title should NOT include the part number. (Part numbers are a separate field.) Keep it as a clear product/service name.
- The description should read like a sentence in a quote sent to a customer — professional, not internal shorthand. Keep technical specifics; drop banter.
- The line_notes field is for caveats, lead time, warranty notes, or optional add-ons. Customer reads this too; keep it concise. If the source notes are bullet-y or jot-form, preserve that structure but tighten the wording.
- Empty input fields MUST stay empty in the output. Never fabricate content for an empty field. Never copy the title into the description, or vice versa.
- Do not invent specs, dates, prices, lead times, or part numbers that aren't in the source.
- No prose, no markdown fences, no additional top-level fields.`;

function buildUserMessage(ctx) {
  const lines = [
    'Polish the line below for a customer-facing quote PDF.',
    '',
    'Line context:',
    `- Account: ${ctx.account_name || '(unknown)'}`,
    `- Opportunity: ${ctx.opp_number || ''} ${ctx.opp_title || ''}`.trim(),
    `- Quote type: ${ctx.quote_type || '(unknown)'}`,
  ];
  if (ctx.part_number) {
    lines.push(`- Part number (do NOT include in title): ${ctx.part_number}`);
  }
  lines.push(
    '',
    'Current line fields:',
    `- Title: ${ctx.title || '(empty)'}`,
    `- Description: ${ctx.description || '(empty)'}`,
    `- Notes: ${ctx.line_notes || '(empty)'}`,
    '',
    'Return polished JSON. Empty fields stay empty.'
  );
  return lines.join('\n');
}
