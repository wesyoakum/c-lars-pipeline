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
    S1["Lead"] --> S2["RFQ received"]
    S2 --> S3["Quote drafted"]
    S3 --> T1[["Task: Submit quote to customer"]]
    T1 --> S4["Quote submitted"]

    S4 --> G1{"Customer response?"}
    G1 --> O1a[/"Accepts"/]
    G1 --> O1b[/"Requests changes"/]
    G1 --> O1c[/"Rejects"/]
    G1 --> O1d[/"Cancels"/]

    O1b --> S5["Quote under revision"]
    S5 --> T2[["Task: Submit revised quote"]]
    T2 --> S6["Revised quote submitted"]
    S6 --> G1

    O1a --> S7["OC drafted"]
    O1c --> TL(["Closed — Lost"])
    O1d --> TC(["Cancelled"])

    S7 --> T3[["Task: Submit OC to customer"]]
    T3 --> S8["OC submitted"]

    S8 --> G2{"Transaction type?"}
    G2 --> O2a[/"Spares or Service"/]
    G2 --> O2b[/"EPS"/]
    G2 --> O2c[/"Refurb"/]

    O2a --> TD(["Completed"])

    O2b --> S9["NTP drafted"]
    S9 --> T4[["Task: Submit NTP to customer"]]
    T4 --> S10["NTP submitted"]
    S10 --> TD

    O2c --> S11["Inspection Report drafted"]
    S11 --> T5[["Task: Send Inspection Report"]]
    T5 --> S12["Inspection Report submitted"]

    S12 --> G3{"Supplemental required?"}
    G3 --> O3a[/"No"/]
    G3 --> O3b[/"Yes"/]

    O3a --> T6[["Task: Send Inspection Report<br/>for customer approval"]]
    T6 --> TD

    O3b --> S13["Supplemental quote drafted"]
    S13 --> T7[["Task: Send supplemental quote<br/>+ Inspection Report"]]
    T7 --> S14["Supplemental quote submitted"]

    S14 --> G4{"Customer response?"}
    G4 --> O4a[/"Accepts"/]
    G4 --> O4b[/"Requests changes"/]
    G4 --> O4c[/"Rejects"/]
    G4 --> O4d[/"Cancels"/]

    O4b --> S15["Supplemental under revision"]
    S15 --> T8[["Task: Submit revised supplemental"]]
    T8 --> S16["Revised supplemental submitted"]
    S16 --> G4

    O4a --> S17["Amended OC drafted"]
    O4c --> S12
    O4d --> TC

    S17 --> T9[["Task: Submit Amended OC"]]
    T9 --> S18["Amended OC submitted"]
    S18 --> TD

    classDef terminal fill:#dafbe1,stroke:#1a7f37,color:#1a7f37
    classDef loss fill:#ffebe9,stroke:#cf222e,color:#cf222e
    classDef gate fill:#fff8c5,stroke:#bf8700,color:#6a4b00
    classDef option fill:#eef4ff,stroke:#3e63dd,color:#1e40af
    classDef task fill:#f6f3ff,stroke:#7c3aed,color:#4c1d95
    class TD terminal
    class TL,TC loss
    class G1,G2,G3,G4 gate
    class O1a,O1b,O1c,O1d,O2a,O2b,O2c,O3a,O3b,O4a,O4b,O4c,O4d option
    class T1,T2,T3,T4,T5,T6,T7,T8,T9 task
        </div>
      </div>

      <div class="workflow-legend" style="margin-top:0.5rem; padding:0.6rem 0.9rem; background:var(--bg-alt); border-radius:var(--radius); display:flex; flex-wrap:wrap; gap:1.2rem; font-size:0.8em;">
        <span><strong>Shape key:</strong></span>
        <span>▭ Status — stage the opp is in</span>
        <span>⟦⟧ Task — auto-created to-do</span>
        <span>◇ Option gate — decision point</span>
        <span>⎸⎹ Option — choice at a gate</span>
        <span>▢ Terminal — end state (won or lost/cancelled)</span>
      </div>
    </section>

    <section class="card">
      <h2>Branch points explained</h2>
      <dl class="workflow-branches">
        <dt>① After quote submission — <em>Customer response?</em></dt>
        <dd>
          <ul>
            <li><strong>Accepts</strong> (PO received) → <code>oc_drafted</code>. OC flow begins — there's no intermediate "Won" state; acceptance just moves straight into OC work.</li>
            <li><strong>Requests changes</strong> → <code>quote_under_revision</code> → revised quote → back to the same question. Any number of revisions is allowed.</li>
            <li><strong>Rejects</strong> → <code>closed_lost</code> (terminal).</li>
            <li><strong>Cancels</strong> → <strong>Cancelled</strong> (terminal). Covers every flavour of "opp no longer active" — customer went quiet, project scrapped, budget pulled, changed vendor, etc. Kept separate from Rejects so reporting can tell "no" apart from "went away."</li>
          </ul>
        </dd>

        <dt>② After OC submitted — <em>Transaction type?</em></dt>
        <dd>
          <ul>
            <li><strong>Spares / Service</strong> → <code>completed</code>. OC is the work-commence trigger.</li>
            <li><strong>EPS</strong> → <code>ntp_drafted</code> → <code>ntp_submitted</code> → <code>completed</code>. Per governance §4.2, EPS work cannot commence on OC alone — customer must provide Authorization to Proceed, then C-LARS issues the NTP.</li>
            <li><strong>Refurb</strong> → <strong>always</strong> goes through an Inspection Report (a controlled document). Decision ③ is made <em>after</em> the inspection, based on what teardown revealed.</li>
          </ul>
        </dd>

        <dt>③ After Inspection Report submitted — <em>Supplemental required?</em></dt>
        <dd>
          <ul>
            <li><strong>No</strong> — teardown confirmed scope matches the baseline. A task is created to send the Inspection Report to the customer for approval. Once the customer approves, the opp advances to <code>completed</code>. The baseline OC remains the work authorization.</li>
            <li><strong>Yes</strong> — teardown found extra scope. A supplemental quote is drafted, then issued. A single task is created to send <strong>both</strong> the supplemental quote and the inspection report to the customer. Decision ④ covers the customer's response to that supplemental.</li>
          </ul>
          The <code>supplemental_quote</code> flag on the opp (0 or 1) records this decision; the stage picker hides the supplemental-loop stages when <code>= 0</code>.
        </dd>

        <dt>④ Customer response on supplemental quote</dt>
        <dd>
          Mirrors decision ① but with a softer rejection path:
          <ul>
            <li><strong>Accepts</strong> → <code>amended_oc_drafted</code> → amended OC → <code>completed</code>.</li>
            <li><strong>Requests changes</strong> → <code>supplemental_quote_under_revision</code> → revised supplemental → back to the same question.</li>
            <li><strong>Rejects</strong> → revert to <code>inspection_report_submitted</code>. The baseline OC still stands; the user can draft a different supplemental or close the opp manually. Rejecting a supplemental does <strong>not</strong> close the opp.</li>
            <li><strong>Cancels</strong> → <strong>Cancelled</strong> (terminal).</li>
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
