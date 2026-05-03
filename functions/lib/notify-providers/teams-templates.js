// functions/lib/notify-providers/teams-templates.js
//
// Adaptive Card templates per event type. Each template returns the
// full webhook POST body (a "MessageCard" or Adaptive Card wrapped in
// the Teams attachments envelope). We use the Adaptive Card form
// because it renders consistently across Teams desktop / web / mobile.

const SITE_BASE = 'https://c-lars-pms.pages.dev';   // for "Open in C-LARS" actions

export function renderTeamsCard(eventType, data, context) {
  if (eventType === 'test') return testCard(data);
  if (eventType === 'task_assigned') return taskAssignedCard(data, context);
  if (eventType === 'task_reminder_fired') return taskReminderCard(data, context);
  if (eventType === 'task_due_soon') return taskDueSoonCard(data, context);
  if (eventType === 'mention') return mentionCard(data, context);
  if (eventType === 'opp_stage_changed') return oppStageCard(data, context);
  if (eventType === 'quote_status_changed') return quoteStatusCard(data, context);
  if (eventType === 'daily_digest') return dailyDigestCard(data, context);
  if (eventType === 'wfm_full_import_done') return wfmFullImportDoneCard(data, context);
  // Fallback — render a generic card so unknown events still surface
  // something useful instead of erroring.
  return genericCard(eventType, data);
}

// --- low-level helpers --------------------------------------------

/** Wrap an Adaptive Card body in the Teams webhook envelope. */
function envelope(adaptiveCardBody, actions) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: adaptiveCardBody,
          actions: actions || [],
        },
      },
    ],
  };
}

function header(text, color) {
  return {
    type: 'TextBlock',
    size: 'Medium',
    weight: 'Bolder',
    text,
    color: color || 'Default',
    wrap: true,
  };
}

function pair(label, value) {
  if (!value) return null;
  return {
    type: 'FactSet',
    facts: [{ title: label, value: String(value) }],
  };
}

function text(s, opts = {}) {
  return {
    type: 'TextBlock',
    text: String(s || ''),
    wrap: true,
    ...opts,
  };
}

function openAction(label, urlPath) {
  return {
    type: 'Action.OpenUrl',
    title: label,
    url: urlPath.startsWith('http') ? urlPath : (SITE_BASE + urlPath),
  };
}

// --- per-event templates ------------------------------------------

function testCard(data) {
  return envelope([
    header('C-LARS PMS — test notification', 'Good'),
    text(data?.message || 'Your channel is wired up.'),
    text('You can disable this channel from Settings → Notifications.', { isSubtle: true, size: 'Small' }),
  ]);
}

function taskAssignedCard(data, context) {
  // data: { task: {body, due_at}, assignedBy: {display_name}, link }
  const body = [
    header('New task assigned to you'),
    text(data.task?.body || '(no description)', { weight: 'Bolder' }),
  ];
  if (data.assignedBy?.display_name) {
    body.push(text('Assigned by ' + data.assignedBy.display_name, { isSubtle: true, size: 'Small' }));
  }
  const dueFact = pair('Due', formatDue(data.task?.due_at));
  if (dueFact) body.push(dueFact);
  if (data.task?.link_label) {
    body.push(pair('Linked to', data.task.link_label));
  }

  const actions = [];
  if (data.link) actions.push(openAction('Open task', data.link));
  return envelope(body, actions);
}

function taskReminderCard(data, context) {
  // The reminder content IS the message — body of the task is what
  // the user wrote when they set the reminder ("call Bob about the
  // valves"). Card title is just "Reminder" so the body shines.
  const body = [
    header('Reminder'),
    text(data.task?.body || data.task?.subject || '(no description)', { weight: 'Bolder', size: 'Medium' }),
  ];
  const dueFact = pair('Due', formatDue(data.task?.due_at));
  if (dueFact) body.push(dueFact);
  if (data.task?.link_label) body.push(pair('On', data.task.link_label));
  const actions = [];
  if (data.link) actions.push(openAction('Open task', data.link));
  return envelope(body, actions);
}

function taskDueSoonCard(data, context) {
  const body = [
    header('Task due soon', 'Warning'),
    text(data.task?.body || '(no description)', { weight: 'Bolder' }),
  ];
  const dueFact = pair('Due', formatDue(data.task?.due_at));
  if (dueFact) body.push(dueFact);
  const actions = [];
  if (data.link) actions.push(openAction('Open task', data.link));
  return envelope(body, actions);
}

function mentionCard(data, context) {
  const body = [
    header(`${data.actor?.display_name || 'Someone'} mentioned you`),
    text(data.note || '', { wrap: true }),
  ];
  if (data.context_label) body.push(pair('On', data.context_label));
  const actions = [];
  if (data.link) actions.push(openAction('Open in C-LARS', data.link));
  return envelope(body, actions);
}

function oppStageCard(data, context) {
  const body = [
    header(`Opportunity moved to ${data.new_stage}`),
    text(data.opp_label || '(opportunity)', { weight: 'Bolder' }),
  ];
  if (data.previous_stage) body.push(pair('Was', data.previous_stage));
  if (data.actor) body.push(text('Changed by ' + data.actor, { isSubtle: true, size: 'Small' }));
  const actions = [];
  if (data.link) actions.push(openAction('Open opportunity', data.link));
  return envelope(body, actions);
}

function quoteStatusCard(data, context) {
  const body = [
    header(`Quote ${data.quote_number}: ${data.new_status}`),
    text(data.quote_label || '', { weight: 'Bolder' }),
  ];
  if (data.previous_status) body.push(pair('Was', data.previous_status));
  const actions = [];
  if (data.link) actions.push(openAction('Open quote', data.link));
  return envelope(body, actions);
}

function dailyDigestCard(data, context) {
  // data: { date, sections: [{ title, items: [{label, link}, ...]}, ...] }
  const body = [
    header(`Daily digest — ${data.date || ''}`),
  ];
  for (const section of (data.sections || [])) {
    if (!section.items || section.items.length === 0) continue;
    body.push(text(section.title, { weight: 'Bolder', size: 'Medium', spacing: 'Medium' }));
    for (const item of section.items.slice(0, 5)) {
      body.push(text('• ' + (item.label || ''), { spacing: 'None' }));
    }
    if (section.items.length > 5) {
      body.push(text(`+ ${section.items.length - 5} more`, { isSubtle: true, size: 'Small', spacing: 'None' }));
    }
  }
  const actions = [];
  actions.push(openAction('Open dashboard', '/'));
  return envelope(body, actions);
}

function wfmFullImportDoneCard(data, context) {
  // data: { status, summary, total_processed, error_count, started_at, finished_at }
  const status = data?.status || 'completed';
  const headerText = status === 'completed' ? 'WFM full import complete'
                   : status === 'cancelled' ? 'WFM full import cancelled'
                   : status === 'failed'    ? 'WFM full import failed'
                   :                          'WFM full import — ' + status;
  const headerColor = status === 'completed' ? 'Good'
                    : status === 'failed'    ? 'Attention'
                    :                          'Warning';

  const body = [ header(headerText, headerColor) ];
  if (data?.summary) {
    body.push(text(data.summary, { wrap: true, size: 'Small' }));
  }
  if (data?.total_processed != null) {
    body.push(pair('Records processed', String(data.total_processed)));
  }
  if (data?.error_count) {
    body.push(pair('Errors', String(data.error_count) + ' (see /settings/wfm-import/history)'));
  }
  if (data?.started_at && data?.finished_at) {
    body.push(pair('Duration', formatDuration(data.started_at, data.finished_at)));
  }

  const actions = [
    openAction('Open WFM import', data?.link || '/settings/wfm-import'),
  ];
  return envelope(body, actions);
}

function formatDuration(startIso, endIso) {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return (m > 0 ? m + ' min ' : '') + s + ' sec';
  } catch (_) { return ''; }
}

function genericCard(eventType, data) {
  return envelope([
    header('C-LARS PMS — ' + eventType),
    text(JSON.stringify(data).slice(0, 400)),
  ]);
}

// --- helpers ------------------------------------------------------

function formatDue(iso) {
  if (!iso) return '';
  // Expect ISO like "2026-04-30T14:00:00Z" or "2026-04-30"
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const datePart = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4]) return `${datePart} ${m[4]}:${m[5]}`;
  return datePart;
}
