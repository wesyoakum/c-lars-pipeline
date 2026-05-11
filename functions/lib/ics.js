// functions/lib/ics.js
//
// RFC 5545 .ics file generation. Used by:
//   - /activities/:id/ics — per-activity download button on detail page
//   - Claudia's `create_ics_file` tool — ad-hoc events generated mid-chat
//
// Times are emitted as UTC with a trailing Z. The DB stores UTC already,
// and Z-UTC renders correctly in Google/Apple/Outlook regardless of
// viewer timezone — saves us from shipping VTIMEZONE blocks.

const PRODID_DEFAULT = '-//C-LARS PMS//ICS Tool//EN';
const FOLD_LIMIT = 75;

/**
 * RFC 5545 §3.1 text escaping: backslash, semicolon, comma, and newline.
 * Order matters — backslash must be first.
 */
function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 §3.1 line folding at 75 octets. We approximate "octet"
 * with code-unit length — adequate for ASCII-heavy content; multi-byte
 * UTF-8 lines may fold a hair early, which is harmless.
 */
function foldLine(line) {
  if (line.length <= FOLD_LIMIT) return line;
  const out = [];
  let rest = line;
  out.push(rest.slice(0, FOLD_LIMIT));
  rest = rest.slice(FOLD_LIMIT);
  while (rest.length > FOLD_LIMIT - 1) {
    out.push(' ' + rest.slice(0, FOLD_LIMIT - 1));
    rest = rest.slice(FOLD_LIMIT - 1);
  }
  if (rest.length) out.push(' ' + rest);
  return out.join('\r\n');
}

/**
 * Convert any input to a Date. Accepts:
 *   - Date instance
 *   - ISO 8601 string (with or without Z)
 *   - number (millis since epoch)
 * Returns null on unparseable input.
 */
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date as UTC in RFC 5545 form: YYYYMMDDTHHMMSSZ.
 */
function fmtUtc(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/**
 * Build a single VEVENT block.
 *
 * @param {object}   opts
 * @param {string}   opts.uid          — globally-unique-ish ID for this event
 * @param {string}   opts.summary      — required, the calendar title
 * @param {string}  [opts.description] — body text (multiline OK; will be escaped)
 * @param {string}  [opts.location]
 * @param {Date|string|number} opts.start
 * @param {Date|string|number} [opts.end] — if omitted, falls back to durationMins
 * @param {number}  [opts.durationMins=30] — applied when `end` is missing
 * @param {string}  [opts.organizer] — email string
 * @param {string[]} [opts.attendees] — email strings
 * @returns {string} VEVENT block (no trailing CRLF)
 */
export function buildIcsEvent({
  uid,
  summary,
  description,
  location,
  start,
  end,
  durationMins = 30,
  organizer,
  attendees,
}) {
  const startDt = toDate(start);
  if (!startDt) throw new Error('buildIcsEvent: start is required and must be a valid date.');
  if (!summary || !String(summary).trim()) throw new Error('buildIcsEvent: summary is required.');
  if (!uid) throw new Error('buildIcsEvent: uid is required.');

  let endDt = toDate(end);
  if (!endDt) endDt = new Date(startDt.getTime() + durationMins * 60_000);
  if (endDt.getTime() <= startDt.getTime()) {
    endDt = new Date(startDt.getTime() + 30 * 60_000);
  }

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtUtc(new Date())}`,
    `DTSTART:${fmtUtc(startDt)}`,
    `DTEND:${fmtUtc(endDt)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (location)    lines.push(`LOCATION:${escapeText(location)}`);
  if (organizer)   lines.push(`ORGANIZER:mailto:${escapeText(organizer)}`);
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      const email = String(a || '').trim();
      if (!email) continue;
      lines.push(`ATTENDEE:mailto:${escapeText(email)}`);
    }
  }
  lines.push('END:VEVENT');

  return lines.map(foldLine).join('\r\n');
}

/**
 * Wrap one or more VEVENT blocks in a full VCALENDAR.
 *
 * @param {object}   opts
 * @param {Array}    opts.events  — array of event arg objects (same shape as buildIcsEvent)
 *                                  OR pre-built VEVENT strings.
 * @param {string}  [opts.prodId]
 * @returns {string} Full .ics text (CRLF terminated)
 */
export function buildIcsCalendar({ events, prodId = PRODID_DEFAULT }) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('buildIcsCalendar: at least one event is required.');
  }
  const veventBlocks = events.map((e) =>
    typeof e === 'string' ? e : buildIcsEvent(e)
  );

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...veventBlocks,
    'END:VCALENDAR',
  ];

  return lines.join('\r\n') + '\r\n';
}
