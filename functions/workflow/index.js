// functions/workflow/index.js
//
// GET /workflow — Visual road map of the opportunity lifecycle.
//
// Embeds a Mermaid flowchart rendered client-side via the Mermaid
// CDN build. The diagram mirrors the stage catalog (migration 0045 —
// universal Change Order model) and the branching logic implemented
// across accept.js, reject.js, submit.js, issue-oc.js, issue-ntp.js,
// jobs/[id]/change-orders/[coId]/issue-amended-oc.js.

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
            from migration 0045.
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
    G2 --> O2a[/"Spares / Service / Refurb"/]
    G2 --> O2b[/"EPS"/]

    O2b --> S9["NTP drafted"]
    S9 --> T4[["Task: Submit NTP to customer"]]
    T4 --> S10["NTP submitted"]

    O2a --> S11["Job in progress"]
    S10 --> S11

    S11 --> G3{"Scope change?"}
    G3 --> O3a[/"No"/]
    G3 --> O3b[/"Yes — open Change Order"/]

    O3a --> TD(["Completed"])

    O3b --> S12["Change order drafted"]
    S12 --> T5[["Task: Submit change order to customer"]]
    T5 --> S13["Change order submitted"]

    S13 --> G4{"Customer response?"}
    G4 --> O4a[/"Accepts"/]
    G4 --> O4b[/"Requests changes"/]
    G4 --> O4c[/"Rejects"/]
    G4 --> O4d[/"Cancels"/]

    O4b --> S14["Change order under revision"]
    S14 --> T6[["Task: Submit revised CO"]]
    T6 --> S15["Revised change order submitted"]
    S15 --> G4

    O4a --> S16["Change order won"]
    O4c --> S11
    O4d --> S11

    S16 --> S17["Amended OC drafted"]
    S17 --> T7[["Task: Submit amended OC"]]
    T7 --> S18["Amended OC submitted"]
    S18 --> S11

    classDef terminal fill:#dafbe1,stroke:#1a7f37,color:#1a7f37
    classDef loss fill:#ffebe9,stroke:#cf222e,color:#cf222e
    classDef gate fill:#fff8c5,stroke:#bf8700,color:#6a4b00
    classDef option fill:#eef4ff,stroke:#3e63dd,color:#1e40af
    classDef task fill:#f6f3ff,stroke:#7c3aed,color:#4c1d95
    class TD terminal
    class TL,TC loss
    class G1,G2,G3,G4 gate
    class O1a,O1b,O1c,O1d,O2a,O2b,O3a,O3b,O4a,O4b,O4c,O4d option
    class T1,T2,T3,T4,T5,T6,T7 task
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
            <li><strong>Spares / Service / Refurb</strong> → <code>job_in_progress</code>. OC is the work-commence trigger; from here the job runs in the external PM system (refurb teardown + inspection happen inside that PM system, not here).</li>
            <li><strong>EPS</strong> → <code>ntp_drafted</code> → <code>ntp_submitted</code> → <code>job_in_progress</code>. Per governance §4.2, EPS work cannot commence on OC alone — customer must provide Authorization to Proceed, then C-LARS issues the NTP.</li>
          </ul>
        </dd>

        <dt>③ During <code>job_in_progress</code> — <em>Scope change?</em></dt>
        <dd>
          <ul>
            <li><strong>No</strong> — the baseline OC remains the work authorization. When the job is done, advance the opp to <code>completed</code>.</li>
            <li><strong>Yes</strong> — open a <strong>Change Order</strong> from the job page. The CO gets its own number (CO-YYYY-NNNN), has its own draft/issue/submit quote cycle, and ends with an Amended OC that authorizes the modified scope. Multiple COs per job are supported — open a new CO each time scope shifts.</li>
          </ul>
          The <code>change_order</code> flag on the opp (0 or 1) gates visibility of the CO-loop stages in the picker.
        </dd>

        <dt>④ Customer response on a change-order quote</dt>
        <dd>
          Mirrors decision ① but with a softer rejection path:
          <ul>
            <li><strong>Accepts</strong> → <code>change_order_won</code> → <code>amended_oc_drafted</code> → amended OC → <code>amended_oc_submitted</code> → back to <code>job_in_progress</code> (or <code>completed</code> if the job's done).</li>
            <li><strong>Requests changes</strong> → <code>change_order_under_revision</code> → revised CO → back to the same question.</li>
            <li><strong>Rejects</strong> or <strong>Cancels</strong> → revert to <code>job_in_progress</code>. The baseline OC still stands; user can open a fresh CO if scope changes again.</li>
          </ul>
        </dd>
      </dl>
    </section>

    <section class="card">
      <h2>Implementation notes</h2>
      <ul class="muted" style="font-size:0.9em">
        <li>Stage transitions go through <code>functions/lib/stage-transitions.js</code> (<code>changeOppStage</code>) so the gate / audit / event-fire side effects are consistent.</li>
        <li>Each "Issue" action fires an event (<code>quote.issued</code>, <code>oc.issued</code>, <code>change_order.issued</code>, <code>change_order.amended_oc_issued</code>) that triggers a seeded auto-task rule creating a "Submit to customer" task. Completing that task walks the opp to the matching <code>*_submitted</code> stage via <code>advanceStageOnTaskComplete</code>.</li>
        <li>Change orders live in their own table (<code>change_orders</code>); CO quotes are regular <code>quotes</code> rows with <code>change_order_id</code> set. A job can have many COs in sequence.</li>
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
