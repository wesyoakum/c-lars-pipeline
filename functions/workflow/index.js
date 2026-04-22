// functions/workflow/index.js
//
// GET /workflow — Visual road map of the opportunity lifecycle.
//
// Embeds a Mermaid flowchart rendered client-side via the Mermaid
// CDN build. The diagram mirrors the stage catalog (migration 0041)
// and the branching logic implemented across accept.js, reject.js,
// submit.js, issue-oc.js, issue-ntp.js, amend-oc.js, and issue-
// inspection-report.js. Not a settings page — it's a reference /
// reasoning aid; may be removed or replaced once the team has the
// flow memorized.

import { layout, htmlResponse, html, raw } from '../lib/layout.js';

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user) return new Response('', { status: 302, headers: { Location: '/login' } });

  const body = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">Workflow</h1>
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.9em">
            Road map of the opportunity lifecycle. Diamonds mark decision
            points; the label on each outgoing arrow explains why the
            path branches that way. Stage keys match the stage catalog
            from migration 0041.
          </p>
        </div>
      </div>

      <div class="workflow-chart" style="padding:1rem; overflow-x:auto;">
        <div class="mermaid">
flowchart TD
    START(["New Opp"]) --> LEAD["Lead"]
    LEAD --> RFQ["RFQ received"]
    RFQ --> AWAIT["Awaiting client feedback"]
    AWAIT --> DRAFT["Quote drafted"]

    DRAFT -->|"User issues quote"| SUB["Quote submitted"]

    SUB --> Q1{"Customer response?"}
    Q1 -->|"Requests changes"| REV["Quote under revision"]
    REV --> RSUB["Revised quote submitted"]
    RSUB --> Q1
    Q1 -->|"Accepts PO received"| WON["Won closed_won"]
    Q1 -->|"Rejects"| LOST["Closed — Lost"]
    Q1 -->|"Goes cold"| DIED["Closed — Died"]

    WON --> OCD["OC drafted"]
    OCD -->|"Issue OC; submit task complete"| OCS["OC submitted"]

    OCS --> Q2{"Transaction type?"}
    Q2 -->|"Spares or Service"| DONE(["Completed"])
    Q2 -->|"EPS"| NTD["NTP drafted"]
    Q2 -->|"Refurb"| Q3{"Supplemental expected?"}

    NTD -->|"Issue NTP; submit task complete"| NTS["NTP submitted"]
    NTS --> DONE

    Q3 -->|"No — supplemental_quote = 0"| DONE
    Q3 -->|"Yes — teardown finds extra scope"| INSP["Inspection Report submitted"]

    INSP --> SQD["Supplemental quote drafted"]
    SQD -->|"Issue"| SQS["Supplemental quote submitted"]

    SQS --> Q4{"Customer response on supplemental?"}
    Q4 -->|"Requests changes"| SQR["Supplemental under revision"]
    SQR --> SQRS["Revised supplemental submitted"]
    SQRS --> Q4
    Q4 -->|"Accepts"| SW["Supplemental won"]
    Q4 -->|"Rejects — revert"| INSP
    Q4 -->|"Goes cold"| LOST

    SW --> AOCD["Amended OC drafted"]
    AOCD -->|"Issue; submit task complete"| AOCS["Amended OC submitted"]
    AOCS --> DONE

    classDef terminal fill:#dafbe1,stroke:#1a7f37,color:#1a7f37
    classDef loss fill:#ffebe9,stroke:#cf222e,color:#cf222e
    classDef decision fill:#fff8c5,stroke:#bf8700
    class DONE terminal
    class LOST,DIED loss
    class Q1,Q2,Q3,Q4 decision
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Branch points explained</h2>
      <dl class="workflow-branches">
        <dt>① After quote submission — <em>Customer response?</em></dt>
        <dd>
          <ul>
            <li><strong>Accepts</strong> (PO received) → <code>closed_won</code>. OC flow begins.</li>
            <li><strong>Requests changes</strong> → <code>quote_under_revision</code> → revised quote → back to the same question. Any number of revisions is allowed.</li>
            <li><strong>Rejects</strong> → <code>closed_lost</code> (terminal).</li>
            <li><strong>Goes cold / no response</strong> → <code>closed_died</code> (terminal, distinct from reject so reporting can separate "they said no" from "they stopped responding").</li>
          </ul>
        </dd>

        <dt>② After OC submitted — <em>Transaction type?</em></dt>
        <dd>
          <ul>
            <li><strong>Spares / Service</strong> → <code>completed</code>. OC is the work-commence trigger.</li>
            <li><strong>EPS</strong> → <code>ntp_drafted</code> → <code>ntp_submitted</code> → <code>completed</code>. Per governance §4.2, EPS work cannot commence on OC alone — customer must provide Authorization to Proceed, then C-LARS issues the NTP.</li>
            <li><strong>Refurb</strong> → decision ③.</li>
          </ul>
        </dd>

        <dt>③ Refurb only — <em>Supplemental expected?</em></dt>
        <dd>
          Set on the opp via the <code>supplemental_quote</code> flag (NULL / 0 / 1).
          <ul>
            <li><strong>No</strong> (<code>= 0</code>) → skip the supplemental loop, straight to <code>completed</code>. Used when teardown confirms scope matches the baseline.</li>
            <li><strong>Yes</strong> (NULL or <code>= 1</code>) → enter the inspection + supplemental loop. Stage picker expands to show all 8 supplemental stages.</li>
          </ul>
        </dd>

        <dt>④ Customer response on supplemental quote</dt>
        <dd>
          Mirrors decision ① but with a softer rejection path:
          <ul>
            <li><strong>Rejects</strong> → revert to <code>inspection_report_submitted</code>. The baseline OC still stands; the user can draft a different supplemental or close the opp manually. Rejecting a supplemental does <strong>not</strong> close the opp as lost (unlike a baseline reject).</li>
            <li><strong>Goes cold</strong> → <code>closed_lost</code>. No revert path for cold supplementals.</li>
            <li><strong>Accepts</strong> → <code>supplemental_won</code> → amended OC → <code>completed</code>.</li>
          </ul>
        </dd>
      </dl>
    </section>

    <section class="card">
      <h2>Implementation notes</h2>
      <ul class="muted" style="font-size:0.9em">
        <li>Stage transitions go through <code>functions/lib/stage-transitions.js</code> (<code>changeOppStage</code>) so the gate / audit / event-fire side effects are consistent.</li>
        <li>Each "Issue" action fires an event (<code>quote.issued</code>, <code>oc.issued</code>, etc.) that triggers a seeded auto-task rule creating a "Submit to customer" task. When that task is marked complete, <code>advanceStageOnTaskComplete</code> in stage-transitions.js walks the opp to the matching <code>*_submitted</code> stage.</li>
        <li>All intermediate stages after <code>closed_won</code> have <code>is_won = 1</code>. The single terminal <code>completed</code> is won + terminal; <code>closed_lost</code> and <code>closed_died</code> are terminal but not won.</li>
        <li>The stage graph is enforced in <em>warn</em> mode — gate violations surface as toast warnings but don't block transitions. The picker UI suggests the next stage; the user can always jump.</li>
      </ul>
    </section>

    <!-- Mermaid renderer. Loaded from the CDN only on this page. -->
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
      mermaid.initialize({
        startOnLoad: true,
        theme: 'default',
        flowchart: { htmlLabels: true, curve: 'basis' },
        securityLevel: 'loose',
      });
    </script>
  `;

  return htmlResponse(layout('Workflow', body, {
    user,
    env: context.data?.env,
    breadcrumbs: [{ label: 'Workflow' }],
  }));
}
