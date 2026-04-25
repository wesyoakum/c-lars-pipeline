// functions/lib/job-tabs.js
//
// Shared tab nav rendered on every job-detail surface (overview, OC,
// NTP). Mirrors the opportunity page's `?tab=…` nav, but here each
// tab is a real route so the URL bar always reflects what the user is
// looking at.
//
// `active` selects the highlighted tab: 'overview' | 'oc' | 'ntp'.
// The NTP tab is hidden for non-EPS jobs since NTP doesn't apply.

import { html, escape } from './layout.js';

export function renderJobTabs(jobId, jobType, active) {
  const isEps = (jobType || '').split(',').includes('eps');
  return html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${active === 'overview' ? 'active' : ''}" href="/jobs/${escape(jobId)}">Overview</a>
      <a class="nav-link ${active === 'oc' ? 'active' : ''}" href="/jobs/${escape(jobId)}/oc">OC</a>
      ${isEps ? html`<a class="nav-link ${active === 'ntp' ? 'active' : ''}" href="/jobs/${escape(jobId)}/ntp">NTP</a>` : ''}
    </nav>`;
}
