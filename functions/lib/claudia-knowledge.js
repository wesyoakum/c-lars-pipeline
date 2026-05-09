// functions/lib/claudia-knowledge.js
//
// Shared knowledge layer used by every Claudia AI flow (chat, triage
// worker, hourly tick, catch-me-up brief, future agentic flows).
//
// The principle: SEPARATE knowledge from behavior.
//   - Knowledge (this module): facts about C-LARS, key people,
//     industry lingo, the user's persistent preferences. Stable
//     across surfaces — Sherman is CPDO whether she's writing chat
//     replies or background-triaging an email.
//   - Behavior (each AI flow's own prompt): voice, output format,
//     anti-patterns, tool-use rules. Task-specific — chat needs
//     personality + casual openers; the triage worker needs strict
//     JSON schema rules; the brief generator needs narrative-style
//     observations.
//
// Each AI flow composes its system prompt as:
//   [shared knowledge] + [task-specific behavior]
// so an edit to "Key people" propagates everywhere on the next call.

/**
 * COMPANY_CONTEXT — what every flow needs to know about C-LARS as
 * the home org. Includes who's on staff (so workers don't ask
 * "is Sherman external?"), what the company makes, who buys it.
 */
export const COMPANY_CONTEXT = `COMPANY CONTEXT — C-LARS

C-LARS, LLC is a U.S.-based engineering and manufacturing company specializing in offshore Launch and Recovery Systems (LARS), hydraulic systems, and handling equipment.

Core products: hydraulic and electric winches; A-frames, cranes, davits; HPUs; control systems and operator stations; docking/latching systems.

Capabilities: mechanical / hydraulic / electrical engineering; fabrication, machining, welding, assembly; system integration and FAT testing; refurbishment and upgrades; offshore-deployment-focused design.

Differentiators: fast lead times, strong custom engineering, AHC integration expertise, high responsiveness.

Customer base: work-class ROV operators, offshore contractors, research organizations, defense / autonomy programs. Global — U.S., Brazil, Canada, UK, Norway, Turkey, Japan, Singapore.

Key people (C-LARS staff — anyone with @c-lars.com email is one of these or a similarly internal role):
- Adam Janac — Owner & CEO; global SME in LARS
- Amanda Ingram — Chief Operating Officer (COO)
- Sherman Watters — Chief Product Development Officer; PE
- Wes Yoakum — Chief Commercial Officer; mechanical engineer; owns sales, marketing, BD
- Kat Deno — Commercial Administrative Assistant; handles spares orders and commercial admin execution

Typical system structure: winch (hydraulic or electric, Lebus grooved) + A-frame or crane (luffing + overboarding) + HPU (closed/open-loop, redundancy options) + control stand + instrumentation (line speed, tension, payout, etc.). Systems must be offshore-capable, maintainable, logistically realistic, with clearly defined interfaces.

Sales context: long cycles, mixed stakeholders, frequent early ambiguity (budgetary pricing, partial specs). Clean concept → quote → execution transition is critical. Watch for: missing inputs before quoting, scope ambiguity, descriptions that don't match deliverables, downstream issues from unclear scope.`;

/**
 * INDUSTRY_TERMS — verbatim-preserve glossary. The model must NOT
 * expand acronyms or substitute alternatives — domain experts read
 * Claudia's output and they expect their lingo back.
 */
export const INDUSTRY_TERMS = `Industry terms — preserve verbatim, do not expand or substitute:
- "VOO" / "vessel of opportunity" — a vessel/ship not yet chosen for a particular job. Used when a quote is for equipment going on a vessel TBD.
- AHC = Active Heave Compensation. FAT = Factory Acceptance Test. RFQ = Request for Quote. HPU = Hydraulic Power Unit. LARS = Launch and Recovery System. ROV = Remotely Operated Vehicle. EPS = Engineered Product System. OC = Order Confirmation. NTP = Notice to Proceed. BANT = Budget / Authority / Need / Timeline. IWOCS = Installation / Workover Control System.
- Capitalized acronyms (EPS, ROV, OC, RFQ, NTP, BANT, IWOCS, etc.) — preserve exact case as written. Do NOT pluralize differently than the user wrote them.
- Pipeline opp numbers like WFM02-25314 / PMS25-25314 — keep with the dash and zero-padding the user wrote.`;

/**
 * userContext — compact "what we know about this specific human"
 * block, built from their persisted memory. Used by every AI flow
 * so Sonnet sees Wes's preferences, family, and calendar context
 * without needing a separate get_memory tool call.
 *
 * Pulls from the assistant_memory table:
 *   - family — wife + kids names + DOBs
 *   - pref.*  — standing preferences (confirm policy, OOO, etc.)
 *   - calendar.url.* — published .ics URLs by label
 *   - remind.* — outstanding reminders the user asked her to surface
 *
 * Pass an array of {key, value} rows (output of `SELECT key, value
 * FROM assistant_memory WHERE user_id = ?`). Returns a string ready
 * to inline into a system prompt, or empty string when memory is
 * empty.
 *
 * @param {object} user
 * @param {string} user.display_name
 * @param {string} user.email
 * @param {Array<{key: string, value: string}>} memoryRows
 */
export function userContext(user, memoryRows = []) {
  const display = user?.display_name || user?.email || 'the user';
  if (!Array.isArray(memoryRows) || memoryRows.length === 0) {
    return `USER CONTEXT — ${display}\n\n(No persisted preferences or facts in memory yet.)`;
  }

  const family = [];
  const prefs = [];
  const reminders = [];
  const calendars = [];
  const other = [];

  for (const row of memoryRows) {
    if (!row || !row.key) continue;
    const k = String(row.key);
    const v = String(row.value || '').trim();
    if (k === 'family') family.push(v);
    else if (k.startsWith('pref.')) prefs.push({ key: k, value: v });
    else if (k.startsWith('remind.')) reminders.push({ key: k, value: v });
    else if (k.startsWith('calendar.url.')) calendars.push({ key: k, value: v });
    else other.push({ key: k, value: v });
  }

  const sections = [`USER CONTEXT — ${display} (${user?.email ?? ''})`, ''];

  if (family.length > 0) {
    sections.push('Family:');
    for (const f of family) sections.push(`- ${f}`);
    sections.push('');
  }

  if (prefs.length > 0) {
    sections.push('Standing preferences (do not violate; honor across all flows):');
    for (const p of prefs) sections.push(`- ${p.key}: ${p.value}`);
    sections.push('');
  }

  if (calendars.length > 0) {
    const labels = calendars
      .map((c) => c.key.slice('calendar.url.'.length))
      .filter((label) => label && label !== 'teamreach') // drop tombstones
      .sort();
    if (labels.length > 0) {
      sections.push(`Configured calendars (${labels.length}): ${labels.join(', ')}.`);
      sections.push('');
    }
  }

  if (reminders.length > 0) {
    sections.push('Active reminders (surface when relevant; mark resolved when handled):');
    for (const r of reminders) sections.push(`- ${r.key}: ${r.value}`);
    sections.push('');
  }

  if (other.length > 0) {
    sections.push('Other persisted notes:');
    for (const o of other) sections.push(`- ${o.key}: ${o.value.slice(0, 200)}${o.value.length > 200 ? '…' : ''}`);
    sections.push('');
  }

  return sections.join('\n').trimEnd();
}

/**
 * dayContext — explicit weekday anchors for "today / tomorrow / next
 * Monday / this weekend" in America/Chicago. Returns a single-line
 * markdown-ish string ready to inline into a system prompt. Bug this
 * fixes: the model occasionally slipped on day labels mid-reply (e.g.
 * listed Saturday's agenda then closed with "Monday's going to be
 * busy"). Giving it the labels up front kills the failure mode.
 *
 * Output looks like:
 *   "DAY ANCHORS — Today: Friday 2026-05-08. Tomorrow: Saturday
 *    2026-05-09. This weekend: Sat 5/9 + Sun 5/10. Next Monday:
 *    2026-05-11. Tonight = this evening of 2026-05-08; do NOT
 *    conflate with tomorrow."
 *
 * Pass `nowMs` (defaults to Date.now()) — used by tests + cron jobs
 * that want a deterministic input.
 */
export function dayContext(nowMs = Date.now()) {
  const ymdFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
  });

  const ctYmd = (offsetDays) => ymdFmt.format(new Date(nowMs + offsetDays * 86400000));
  const ctDay = (offsetDays) => dayFmt.format(new Date(nowMs + offsetDays * 86400000));
  const shortMd = (ymd) => {
    const [y, m, d] = ymd.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };

  const todayYmd = ctYmd(0);
  const todayDay = ctDay(0);
  const tomorrowYmd = ctYmd(1);
  const tomorrowDay = ctDay(1);

  // Find next Monday — could be today (if today IS Monday) through 7 days out.
  // Mon=0 in this calc. We want strictly "next Monday after today" except when today is Monday.
  let mondayOffset = 1;
  while (mondayOffset <= 7 && ctDay(mondayOffset) !== 'Monday') mondayOffset++;
  const mondayYmd = ctYmd(mondayOffset);

  // This weekend = the next Saturday + Sunday after today (or today if today is Sat/Sun).
  let satOffset = 0;
  while (satOffset <= 7 && ctDay(satOffset) !== 'Saturday') satOffset++;
  const satYmd = ctYmd(satOffset);
  const sunYmd = ctYmd(satOffset + 1);

  return [
    'DAY ANCHORS:',
    `- Today: ${todayDay} ${todayYmd} (${shortMd(todayYmd)})`,
    `- Tomorrow: ${tomorrowDay} ${tomorrowYmd} (${shortMd(tomorrowYmd)})`,
    `- This weekend: Sat ${shortMd(satYmd)} + Sun ${shortMd(sunYmd)}`,
    `- Next Monday: ${mondayYmd} (${shortMd(mondayYmd)})`,
    `- Tonight = this evening of ${todayYmd}. Do NOT mix tonight references into a tomorrow agenda — they are different days.`,
  ].join('\n');
}

/**
 * loadUserMemoryRows — convenience helper for AI flows that need to
 * build a userContext block. Reads all keys for the given user_id.
 * Returns an empty array on error so callers don't have to handle
 * the failure mode.
 */
export async function loadUserMemoryRows(env, userId) {
  if (!env?.DB || !userId) return [];
  try {
    const stmt = env.DB.prepare(
      `SELECT key, value, updated_at
         FROM assistant_memory
        WHERE user_id = ?
        ORDER BY key`
    ).bind(userId);
    const { results } = await stmt.all();
    return results || [];
  } catch (err) {
    console.warn('[claudia-knowledge] loadUserMemoryRows failed:', err?.message || err);
    return [];
  }
}
