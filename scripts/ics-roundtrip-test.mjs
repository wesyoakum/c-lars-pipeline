// scripts/ics-roundtrip-test.mjs
//
// Round-trip verification: feed the ICS we generate back through the
// EXACT parseIcs / unescapeIcs algorithm used by
// functions/lib/claudia-calendar.js (the app's own external-feed parser).
// If round-trip is clean, external calendar apps (Google/Apple/Outlook)
// following the same RFC 5545 rules will also accept the output.
//
// Run with: node scripts/ics-roundtrip-test.mjs
// This file is for local verification only; not wired into any route.

import { buildIcsCalendar } from '../functions/lib/ics.js';

// ─── replicas of the unexported parser helpers ─────────────────────
function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const params = keyPart.split(';');
      const key = params[0];
      if (!(key in cur)) cur[key] = value;
    }
  }
  return events;
}
function unescapeIcs(s) {
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
// ───────────────────────────────────────────────────────────────────

const trickySummary = 'Vendor review, Q2; high — note commas, semicolons & a backslash \\.';
const trickyDesc = 'Line 1\nLine 2 has a comma, semicolon; and backslash \\\nLine 3';
const trickyLoc = 'Room B, 2nd floor';

const ics = buildIcsCalendar({
  events: [
    {
      uid: 'rt-1@c-lars.com',
      summary: trickySummary,
      description: trickyDesc,
      location: trickyLoc,
      start: '2026-05-15T14:00:00Z',
      durationMins: 45,
      organizer: 'wes@c-lars.com',
      attendees: ['alice@x.com', 'bob@y.com'],
    },
    {
      uid: 'rt-2@c-lars.com',
      summary: 'Short event',
      start: '2026-05-16T08:00:00Z',
    },
  ],
});

const parsed = parseIcs(ics);
const summaries = parsed.map((e) => unescapeIcs(e.SUMMARY));
const descs = parsed.map((e) => unescapeIcs(e.DESCRIPTION || ''));
const locs = parsed.map((e) => unescapeIcs(e.LOCATION || ''));
const starts = parsed.map((e) => e.DTSTART);
const ends = parsed.map((e) => e.DTEND);
const uids = parsed.map((e) => e.UID);

const checks = [
  ['parsed 2 events',           parsed.length === 2],
  ['summary[0] round-trips',    summaries[0] === trickySummary],
  ['summary[1] round-trips',    summaries[1] === 'Short event'],
  ['description[0] round-trips', descs[0] === trickyDesc],
  ['location[0] round-trips',   locs[0] === trickyLoc],
  ['DTSTART[0] is UTC',         starts[0] === '20260515T140000Z'],
  ['DTEND[0] = start + 45min',  ends[0] === '20260515T144500Z'],
  ['DTSTART[1] is UTC',         starts[1] === '20260516T080000Z'],
  ['DTEND[1] default to +30m',  ends[1] === '20260516T083000Z'],
  ['UID[0]',                    uids[0] === 'rt-1@c-lars.com'],
  ['UID[1]',                    uids[1] === 'rt-2@c-lars.com'],
  ['ORGANIZER[0]',              parsed[0].ORGANIZER === 'mailto:wes@c-lars.com'],
  // Only first ATTENDEE is captured by parseIcs (it's how the calendar
  // parser is written — "first wins"), so just verify it was preserved.
  ['ATTENDEE[0] first wins',    parsed[0].ATTENDEE === 'mailto:alice@x.com'],
];

let failed = 0;
console.log('--- ROUND-TRIP: build → parse → unescape ---');
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
}

if (failed > 0) {
  console.log('');
  console.log('--- raw parsed[0] ---');
  console.log(JSON.stringify(parsed[0], null, 2));
  process.exitCode = 1;
} else {
  console.log('');
  console.log('All ' + checks.length + ' round-trip checks passed.');
}
