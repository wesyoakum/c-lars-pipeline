# WFM → Pipeline schema mapping

**Status:** Phase 1 draft — schema sign-off (v2 — refinements applied).
**Last updated:** 2026-04-30
**Inputs:** `docs/wfm-api-probe-results.md` + `migrations/0001_initial.sql`.

This doc maps every WFM entity onto Pipeline. Once §11 decisions are
settled, the importer follows the table mechanically.

---

## 0. Principles (from user refinements, v2)

Three rules drive the rest of this doc:

1. **Pipeline UUIDs are Pipeline-generated.** The WFM UUID is foreign
   data; it lives in `external_id` (with `external_source = 'wfm-*'`),
   never as a Pipeline primary key. Re-imports are idempotent on
   `(external_source, external_id)`.

2. **Lose nothing.** Every WFM field on every imported record gets a
   home in Pipeline. We use a two-tier approach:
   - **Typed columns** for fields actually displayed/filtered in the
     UI (or that we'll need first-class for business logic).
   - **`wfm_payload` JSON column** on every WFM-imported table —
     stores the *full* parsed WFM record verbatim. Anything not yet
     promoted to a typed column is still queryable via SQLite's JSON
     functions, and re-imports overwrite it (so it stays fresh).
   No more `_drop_` entries. Either it's typed, or it's in the payload.

3. **Hybrid Lead-vs-Job model** (§3): WFM Lead → opportunity. WFM Job
   → opportunity (won) + a `jobs` row only when there's a real
   customer PO.

These three drove the field-by-field mapping below; if anything in the
mapping contradicts them, the principles win — flag and I'll fix.

---

## Entity-level overview

| WFM entity | → Pipeline | Notes |
|---|---|---|
| Client | accounts | 1:1, idempotent on UUID |
| Client.Contacts.Contact[] | contacts | Walked via `/client.api/get/{UUID}` |
| Lead | opportunities | Pre-quote / early-stage |
| Job | opportunities (won) ± jobs | Hybrid per Principle 3 |
| Quote | quotes (+ cost_builds) | Lines fetched via `/quote.api/get/{uuid}` |
| Staff | users | Match by email; full WFM record kept in `users.wfm_payload` |
| Custom Field Def | metadata only | Per-record values folded into target row's `wfm_payload` |
| Category (lead) | mapped to opportunities.stage / .transaction_type | See §6 |
| Task (template) | wfm_task_templates (NEW table) | "WELDING / ENGINEERING" — kept as raw catalog |
| Template (job) | wfm_job_templates (NEW table) | Same — kept as raw catalog |
| Supplier | suppliers (NEW table) | Full record + payload |
| Time entry | time_entries (NEW table) | Full record + payload |
| Invoice | invoices (NEW table) | Full record + payload |
| Document (client + job) | documents (in R2) | Walked from parent records, file → R2, metadata → documents |

---

## 1. Clients → Accounts

```
WFM Client                            Pipeline accounts
─────────────────────────             ─────────────────────────
UUID                              →   external_id (+ external_source='wfm')
Name                              →   name
Email                             →   email                       [NEW COLUMN]
Phone                             →   phone
Fax                               →   fax                         [NEW COLUMN]
Website                           →   website
Address+City+Region+PostCode+Country →   address_billing (joined with newlines)
PostalAddress+PostalCity+...      →   address_physical
WebURL                            →   external_url                [NEW COLUMN]  (per user note: WebURL belongs in a website-shaped field, not in notes)
AccountManager (text name)        →   account_manager_name        [NEW COLUMN]  (raw WFM string)
                                  +   owner_user_id (matched to users.email when AccountManager-text resolves)
ReferralSource                    →   referral_source             [NEW COLUMN]
ExportCode                        →   export_code                 [NEW COLUMN]
IsArchived ('Yes'/'No')           →   is_archived (1/0)           [NEW COLUMN]
IsProspect ('Yes'/'No')           →   is_prospect (1/0)           [NEW COLUMN]
IsDeleted ('Yes'/'No')            →   is_deleted (1/0)            [NEW COLUMN]
Type{Name,CostMarkup,             →   wfm_payload (Type subtree)
 PaymentTerm,PaymentDay}              + the full record, intact, anyway
(everything not listed above)     →   wfm_payload (full record JSON) [NEW COLUMN]
```

**Sample (ROVOP Inc):**
```
external_id      = a01f3597-afa9-4213-92d4-aaae532bc001
external_source  = wfm
name             = ROVOP Inc
email            = (empty)
phone            = (empty)
fax              = (empty)
website          = (empty)
address_billing  = ROVOP Americas LLC\n2000 W. Sam Houston Pkwy\n...
address_physical = 1121 Decker Drive\nMandeville, LA 70471\n...
external_url     = https://app.workflowmax.com/organizations/.../clients/.../details
referral_source  = (empty)
export_code      = (empty)
is_archived      = 0
is_prospect      = 0
is_deleted       = 0
account_manager_name = (empty)
owner_user_id    = (empty)
wfm_payload      = {"UUID":"a01f...", "Name":"ROVOP Inc", "Type":{"Name":"",...}, ...}
```

---

## 2. Client.Contacts.Contact[] → Contacts

```
WFM Contact                 Pipeline contacts
─────────────────           ─────────────────
UUID                    →   external_id (+ external_source='wfm')
Name (full)             →   first_name + last_name (split on first space)
Position                →   title
Email                   →   email
Phone                   →   phone
Mobile                  →   mobile
IsPrimary ("Yes"/"No")  →   is_primary (1/0)
Salutation              →   salutation                   [NEW COLUMN]
Addressee               →   addressee                    [NEW COLUMN]
(everything else)       →   wfm_payload                  [NEW COLUMN]
```

**Importer flow** (two-pass):
1. Walk `/client.api/list` paginated; INSERT/UPDATE accounts on `external_id`.
2. For each account, call `/client.api/get/{UUID}` to read its Contacts; INSERT/UPDATE contacts FK'd to the Pipeline account.

ROVOP Inc had 4 contacts in the probe sample (Doug Potter, Reed Curry, Stuart Campbell, Mike Smith).

---

## 3. Leads + Jobs → Opportunities (hybrid model — Principle 3)

### Lead → opportunity field mapping

```
WFM Lead                  Pipeline opportunities
─────────────────         ─────────────────────────
UUID                  →   external_id (+ external_source='wfm-lead')
Name                  →   title
Description           →   description
State (Current/Won/Lost) →   stage (combined with Category — see §6)
EstimatedValue        →   estimated_value_usd
Date                  →   created_at (server preserves WFM-side timestamp)
DateWonLost           →   actual_close_date (when state ≠ Current)
Category              →   transaction_type + stage (see §6)
                      +   wfm_category                  [NEW COLUMN]  (raw "3 Opportunity" preserved)
Client.UUID           →   account_id (re-key from accounts.external_id)
Contact.UUID          →   primary_contact_id (re-key from contacts.external_id)
Owner.UUID            →   owner_user_id (re-key via Staff.Email → users.email)
Dropbox               →   wfm_payload (deprecated WFM placeholder string)
(everything else)     →   wfm_payload                   [NEW COLUMN]
```

(Leads don't have a WebURL field per the probe — only Client / Job / Staff do.)

**Sample (WROV LARS):**
```
title              = WROV LARS
transaction_type   = eps           (from §6 mapping)
stage              = quote_drafted (from State='Current' + Category='3 Opportunity')
wfm_category       = 3 Opportunity
estimated_value_usd = 1200000
account_id         = (Pipeline ID for "Saab")
primary_contact_id = (Pipeline ID for "Mike Thomson")
owner_user_id      = (Pipeline ID for "Wes Yoakum" matched on email)
external_id        = a099809b-c501-4307-9fb7-7cd7b48653be
external_source    = wfm-lead
wfm_payload        = {"UUID":"a09...", "Name":"WROV LARS", "Category":"3 Opportunity", ...}
```

### Job → opportunity (and optionally jobs) field mapping

If the WFM Job has a matching Lead via the linkage in
WFM-managed quote→job chain, **update** the existing opportunity to
stage='closed_won'. If no matching Lead, **synthesize** a new
opportunity at stage='closed_won'.

```
WFM Job                       Pipeline opportunities (when synthesizing)
─────────────────             ─────────────────────────
UUID                      →   external_id (+ external_source='wfm-job')
Name                      →   title
Description               →   description
Client.UUID               →   account_id
Type ("NEW EQUIPMENT")    →   transaction_type (per §6) + wfm_type [NEW COLUMN]
State (PLANNED, etc.)     →   stage (typically 'closed_won')
StartDate                 →   actual_close_date (proxy for "deal closed")
ClientOrderNumber         →   passed to jobs.customer_po_number when we synthesize a jobs row
ApprovedQuoteUUID         →   used to link quotes
DateCreatedUtc            →   created_at
DateModifiedUtc           →   updated_at
WebURL                    →   external_url
Manager.UUID              →   project_manager_user_id        [NEW COLUMN]
Partner.UUID              →   salesperson_user_id (existing column)
DueDate                   →   wfm_payload (operational, lives elsewhere)
(everything else)         →   wfm_payload
```

If we ALSO create a `jobs` row (when ClientOrderNumber is set —
hybrid Principle 3):

```
WFM Job                   Pipeline jobs
─────────────────         ─────────────────────────
UUID                  →   external_id (+ external_source='wfm-job')   [NEW COLUMN — see §10]
ID (C300, INTERNAL)   →   wfm_number                                  [NEW COLUMN] (Pipeline auto-generates JOB-2026-NNNN as primary number)
Name                  →   title
Type                  →   job_type
State                 →   status (mapping in §7)
ClientOrderNumber     →   customer_po_number
StartDate             →   handed_off_at
Manager.UUID          →   project_manager_user_id                     [NEW COLUMN]
WebURL                →   external_url                                [NEW COLUMN]
(everything else)     →   wfm_payload                                 [NEW COLUMN]
```

---

## 4. Quotes → Quotes (+ cost_builds)

```
WFM Quote                       Pipeline quotes
─────────────────               ─────────────────────────
UUID                        →   external_id (+ external_source='wfm')
ID (Q25008)                 →   wfm_number              [NEW COLUMN] (Pipeline still auto-generates Q-2026-NNNN)
Type ("Quote")              →   wfm_type                [NEW COLUMN] (raw WFM type — typically "Quote", but field exists)
                            +   quote_type (derived from parent opp's transaction_type)
State (Draft/Issued/...)    →   status (mapping in §7) + wfm_state [NEW COLUMN] (raw WFM state preserved)
Name                        →   title
Description                 →   description
Date                        →   created_at
ValidDate                   →   valid_until
Amount                      →   subtotal_price
AmountTax                   →   tax_amount
AmountIncludingTax          →   total_price
EstimatedCost*              →   linked cost_builds row (total_cost = EstimatedCost)
LeadUUID                    →   opportunity_id (re-key from opportunities.external_id)
JobUUID                     →   alternate re-key path; LeadUUID preferred
Budget                      →   wfm_budget              [NEW COLUMN] (raw, even though redundant with totals)
OptionExplanation           →   notes_customer
(everything else)           →   wfm_payload             [NEW COLUMN]
```

### Quote line items (`quote_lines`) require a per-quote detail call

WFM list endpoints don't include line items. To get them, the importer
calls `/quote.api/get/{UUID}` per quote and pulls `DetailedQuote.Costs`
+ `DetailedQuote.Tasks`. The full DetailedQuote response is stashed in
`quotes.wfm_payload`, replacing the lighter list-shape payload.

That's one extra API call per quote. With 60/min and a few hundred
quotes, this is one batch of overnight work. Phase-1 importer will
throttle to ~50/min for safety margin.

### Sample (Squatty Dual HPU)
```
external_id      = a02af19e-cc09-4919-84d3-10e49964a629
external_source  = wfm
title            = Squatty Dual HPU
opportunity_id   = (Pipeline ID for the Helix Robotics deal)
quote_type       = eps        (from parent opp transaction_type)
status           = submitted  (from State='Issued')
wfm_state        = Issued
wfm_number       = Q25011
wfm_type         = Quote
wfm_budget       = (empty)
subtotal_price   = 596000.0000
tax_amount       = 0.0000
total_price      = 596000.0000
valid_until      = 2025-11-21T00:00:00
notes_customer   = (empty — OptionExplanation was empty)
description      = "Due March 1st to ship to Norway\nGoes with two blue 9966M A-Frames..."
wfm_payload      = {full DetailedQuote JSON, including Costs[] and Tasks[]}
```

---

## 5. Staff → Users (lookup-only, plus full WFM record retained)

Pipeline already has `users` populated from Cloudflare Access. The
importer:
1. Calls `/staff.api/list` once.
2. For each Staff record, finds the matching Pipeline user by email.
3. **Updates** that user's row to set `external_source='wfm'`,
   `external_id=<WFM Staff.UUID>`, `external_url=<WebURL>`, and
   `wfm_payload=<full Staff record>`. The user's `display_name` and
   `email` continue to come from Cloudflare Access (don't overwrite).
4. If no Pipeline user matches a Staff.Email, log it. Don't create a
   new Pipeline user — Pipeline-user creation is gated by Cloudflare
   Access.

```
WFM Staff                Pipeline users
─────────────────        ─────────────────
UUID                 →   external_id (+ external_source='wfm')   [NEW COLUMNS]
Email                →   (matching key — read-only)
Name                 →   wfm_payload (Pipeline display_name comes from Access)
Phone                →   wfm_payload
Mobile               →   wfm_payload
Address              →   wfm_payload
PayrollCode          →   wfm_payload
WebURL               →   external_url                            [NEW COLUMN]
(everything else)    →   wfm_payload                             [NEW COLUMN]
```

This way every WFM Staff field is preserved on the matching Pipeline
user, but the day-to-day fields (email, display_name, role) keep
coming from Cloudflare Access.

---

## 6. Stage / Category / Type mapping

Two classification axes feed Pipeline:

### 6a. WFM Lead.Category (numbered) → opportunities.stage

Final mapping against the production stage catalog (post-migration
0062/0063, which renamed `closed_*` to `won`/`lost`/`abandoned`):

```
WFM Lead.Category    Pipeline stage_key   Pipeline label
─────────────────    ──────────────────   ─────────────────────────
"1 Identified"   →   lead                 Lead
"2 Qualifying"   →   rfq_received         RFQ received
"3 Opportunity"  →   quote_drafted        Quote drafted
"4 Quoted"       →   quote_submitted      Quote submitted
"5 Won"          →   won                  Won (OC issued)
"6 Lost"         →   lost                 Lost
```

### Lead.State overrides
Regardless of Category, WFM Lead.State takes precedence at the terminal end:
- `Current` → keep the Category-derived stage
- `Won`     → override to `won`
- `Lost`    → override to `lost`

The raw WFM Category text is preserved in `opportunities.wfm_category`
on every imported opp.

### What about the rest of the rich funnel?

Pipeline's production catalog has a much richer post-quote and post-win
flow than WFM tracks:

```
Pre-quote:    lead → rfq_received → awaiting_client_feedback
Quote cycle:  quote_drafted → quote_submitted → quote_under_revision → revised_quote_submitted
OC / win:     oc_drafted → won → oc_submitted
Execution:    job_in_progress → change_order_drafted → change_order_submitted
              → change_order_under_revision → revised_change_order_submitted
              → change_order_won → amended_oc_drafted → amended_oc_submitted
              → completed
Terminal:     lost · abandoned
```

WFM imports only ever land an opportunity in the **early** stages
(lead / rfq_received / quote_drafted / quote_submitted) or the
terminal ones (won / lost). The intermediate revision and
post-execution stages are populated when C-LARS uses Pipeline as the
system of record going forward — WFM never tracked any of that detail
to begin with.

WFM Job.State (PLANNED / PRODUCTION / COMPLETED / CANCELLED) maps
into the post-win execution band:

```
WFM Job.State        Pipeline stage_key
─────────────────    ──────────────────
PLANNED          →   won                 (OC issued; production hasn't started yet)
PRODUCTION       →   job_in_progress
COMPLETED        →   completed
CANCELLED        →   abandoned
```

If a WFM Lead and a WFM Job both reference the same opportunity, the
Job's State wins (it's later in the lifecycle and more authoritative).

### 6b. WFM Categories list (global) AND WFM Job.Type → opportunities.transaction_type

```
WFM Category (global)     Pipeline transaction_type    Internal note appended?
─────────────────         ─────────────────────────    ──────────────────────────
NEW EQUIPMENT         →   eps                          (no — direct map)
SPARES                →   spares                       (no — direct map)
REFURBISHMENT         →   refurb                       (no — direct map)
SERVICE               →   service                      (no — direct map)
SUPPLIES              →   spares                       YES — note: "WFM category: SUPPLIES (mapped → spares)"
WARRANTY              →   service                      YES — note: "WFM category: WARRANTY (mapped → service)"
CYLINDERS             →   spares                       YES — note: "WFM category: CYLINDERS (mapped → spares)"
REFURB CYLINDERS      →   refurb                       YES — note: "WFM category: REFURB CYLINDERS (mapped → refurb)"
```

**Rules:**
- The verbatim WFM string is **always** preserved in
  `opportunities.wfm_type` and `opportunities.wfm_category` (Principle 2).
- For the four merged categories, the importer **also** appends a one-line
  note to `opportunities.notes_internal` so a salesperson sees the
  original category right on the opportunity page without inspecting raw
  data. Format: `[WFM] Original category: <CATEGORY> (mapped → <transaction_type>).`
- Direct-map categories (NEW EQUIPMENT / SPARES / REFURBISHMENT /
  SERVICE) get no note — there's nothing surprising to flag.
- If `notes_internal` is already populated when the import runs (e.g. on a
  re-import of an opportunity the user has been editing), the WFM
  note is appended on a new line, not overwritten.

---

## 7. State / Status mapping

### WFM Lead.State → opportunities.stage modifier
- `Current` → keep the Category-derived stage from §6a
- `Won`     → override to `closed_won`
- `Lost`    → override to `closed_lost`

### WFM Quote.State → quotes.status (raw also kept in quotes.wfm_state)
```
Draft       → draft
Issued      → submitted
Accepted    → accepted
Declined    → rejected
Archived    → expired (or 'superseded' if a newer revision exists)
```

### WFM Job.State → jobs.status (only if synthesizing a jobs row)
```
PLANNED         → created
PRODUCTION      → handed_off
COMPLETED       → handed_off (+ actual_close_date on parent opp)
CANCELLED       → cancelled
```

(The corresponding opportunity.stage mapping is in §6a above:
PLANNED → won, PRODUCTION → job_in_progress, etc.)

---

## 8. Custom fields

**Status:** Complete catalog confirmed via
`/settings/wfm-import/probe-customfields` (v0.446) — 18 definitions in
total. Implementation of the typed-column promotions is **deferred to
the real migration** (§14); for now the importer leaves customs
untouched in `wfm_payload.customFields` once that key is wired up.

Per-record custom-field values are read from the entity-specific
endpoint (e.g. `/lead.api/get/{UUID}/customfield`). At import time we'll:

1. **Promote known-useful customs to typed columns** (per the table below).
2. **Merge the full custom-field map into the target row's `wfm_payload.customFields` key.**
   So even un-promoted customs are preserved verbatim.

### Complete catalog (all 18 definitions)

#### Quote-applicable (10)

| WFM custom field | Type | Promotion target |
|---|---|---|
| `RFQReceivedDate` | Date | → `opportunities.rfq_received_at` (NEW) — funnel-timing event; lives on the parent opportunity. When multiple quotes per opp, use the earliest non-null. |
| `OCDate` | Date | → `quotes.oc_received_at` (NEW) — date the customer's OC was issued for this quote. |
| `QuoteDueDate` | Date | → `quotes.quote_due_date` (NEW). **Do NOT override `valid_until`** — preserve as a separate column. The two often differ in practice (ValidDate = quote expiry, QuoteDueDate = when *we* committed to deliver the quote). |
| `CustomerPO` | Text | → `opportunities.customer_po_number` (column already exists). |
| `JobNumber` | Text | leave in `wfm_payload.customFields` (cross-reference only; Pipeline has its own job numbering). |
| `QuotedDelivery` | Text | → `quotes.quoted_delivery` (NEW) — free-text delivery terms we offered. |
| `RequestedDelivery` | Text | → `quotes.requested_delivery` (NEW) — free-text delivery the customer asked for. |
| `QuoteNotesExternal` | Multi-line | append to `quotes.notes_customer`. |
| `QuoteNotesInternal` | Multi-line | append to `quotes.notes_internal`. |
| `QuoteTerms` | Multi-line | → `quotes.payment_terms`. |

#### Job-applicable (3)

| WFM custom field | Type | Promotion target |
|---|---|---|
| `Order Confirmation Date` | Date | → `jobs.oc_received_at` (NEW). When the parent opp is also being touched, mirror to `opportunities.actual_close_date` if currently null. |
| `NoticeToProceedDate` | Date | → `jobs.ntp_at` (NEW). |
| `Delivery Address` | Multi-line | → `jobs.delivery_address` (already in §10 plan). |

#### Lead-applicable (1)

| WFM custom field | Type | Promotion target |
|---|---|---|
| `Hot Sheet` | Checkbox | → `opportunities.is_hot_sheet` (already in §10 plan). |

#### JobCost-applicable (4) — line-item level

| WFM custom field | Type | Promotion target |
|---|---|---|
| `MATERIAL DESC` | Text | → `cost_lines.material_desc` (already in §10 plan). |
| `REV` | Text | → `cost_lines.rev` (already in §10 plan). |
| `DRAWING REFERENCE` | Text | → `cost_lines.drawing_reference` (already in §10 plan). |
| `TAG` | Text | → `cost_lines.tag` (already in §10 plan). |

#### Client / Contact / Supplier / JobTask / JobTime — **none**

(No custom fields on these entities in the C-LARS WFM tenant.)

If WFM adds new custom fields later, they automatically land in
`wfm_payload.customFields` once the importer is wired up — no schema
migration needed unless we want them as filterable columns.

---

## 9. Documents

Documents are nested per Client and per Job. The probe confirmed both
list endpoints return 200; binary fetch endpoint TBD (probably
`/document.api/get/{UUID}` or via the metadata's URL field — Phase 1
importer will probe this on the first real document encountered).

```
WFM Document field        Pipeline documents
─────────────────         ─────────────────
UUID                  →   external_id (+ external_source='wfm') [NEW COLUMNS on documents]
Name / FileName       →   title
Type                  →   kind (heuristically mapped from extension or MIME)
FileSize              →   size_bytes
UploadDate            →   uploaded_at
WebURL                →   external_url                          [NEW COLUMN on documents]
(binary content)      →   R2 at accounts/<pipeline_account_id>/<wfm_doc_uuid>-<safe_name>
                          or jobs/<pipeline_job_id>/...
(everything else)     →   wfm_payload                           [NEW COLUMN on documents]
```

The `documents` table FKs to opportunity/quote/job/account; we set
whichever parent is appropriate based on which WFM endpoint surfaced
the doc.

---

## 10. Required schema changes (consolidated)

```sql
-- migrations/0064_wfm_import_support.sql
-- (0062 + 0063 already shipped as part of the funnel-rename cleanup;
-- this WFM-specific migration is now 0064.)
-- Adds the columns and tables needed to import WFM data without
-- losing any field. wfm_payload is JSON (TEXT in SQLite); use
-- json_extract() / json_each() to query.

-- ----- accounts -----
ALTER TABLE accounts ADD COLUMN email                  TEXT;
ALTER TABLE accounts ADD COLUMN fax                    TEXT;
ALTER TABLE accounts ADD COLUMN external_url           TEXT;
ALTER TABLE accounts ADD COLUMN account_manager_name   TEXT;
ALTER TABLE accounts ADD COLUMN referral_source        TEXT;
ALTER TABLE accounts ADD COLUMN export_code            TEXT;
ALTER TABLE accounts ADD COLUMN is_archived            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_prospect            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_deleted             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN wfm_payload            TEXT;   -- JSON

-- ----- contacts -----
ALTER TABLE contacts ADD COLUMN salutation             TEXT;
ALTER TABLE contacts ADD COLUMN addressee              TEXT;
ALTER TABLE contacts ADD COLUMN wfm_payload            TEXT;

-- ----- opportunities -----
ALTER TABLE opportunities ADD COLUMN wfm_category      TEXT;   -- "3 Opportunity"
ALTER TABLE opportunities ADD COLUMN wfm_type          TEXT;   -- "NEW EQUIPMENT"
ALTER TABLE opportunities ADD COLUMN external_url      TEXT;
ALTER TABLE opportunities ADD COLUMN is_hot_sheet      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN rfq_received_at   TEXT;
ALTER TABLE opportunities ADD COLUMN wfm_payload       TEXT;

-- ----- jobs -----
ALTER TABLE jobs ADD COLUMN external_source            TEXT;
ALTER TABLE jobs ADD COLUMN external_id                TEXT;
ALTER TABLE jobs ADD COLUMN external_url               TEXT;
ALTER TABLE jobs ADD COLUMN wfm_number                 TEXT;
ALTER TABLE jobs ADD COLUMN project_manager_user_id    TEXT REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN delivery_address           TEXT;
ALTER TABLE jobs ADD COLUMN wfm_payload                TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ext
  ON jobs(external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ----- quotes -----
ALTER TABLE quotes ADD COLUMN wfm_number               TEXT;
ALTER TABLE quotes ADD COLUMN wfm_type                 TEXT;
ALTER TABLE quotes ADD COLUMN wfm_state                TEXT;
ALTER TABLE quotes ADD COLUMN wfm_budget               TEXT;
ALTER TABLE quotes ADD COLUMN external_url             TEXT;
ALTER TABLE quotes ADD COLUMN wfm_payload              TEXT;

-- ----- cost_lines (custom-field promotions) -----
ALTER TABLE cost_lines ADD COLUMN material_desc        TEXT;
ALTER TABLE cost_lines ADD COLUMN rev                  TEXT;
ALTER TABLE cost_lines ADD COLUMN drawing_reference    TEXT;
ALTER TABLE cost_lines ADD COLUMN tag                  TEXT;
ALTER TABLE cost_lines ADD COLUMN wfm_payload          TEXT;   -- only when sourced from WFM JobCost

-- ----- users (lookup-only — no creation, only enrichment) -----
ALTER TABLE users ADD COLUMN external_source           TEXT;
ALTER TABLE users ADD COLUMN external_id               TEXT;
ALTER TABLE users ADD COLUMN external_url              TEXT;
ALTER TABLE users ADD COLUMN wfm_payload               TEXT;

-- ----- documents -----
ALTER TABLE documents ADD COLUMN external_source       TEXT;
ALTER TABLE documents ADD COLUMN external_id           TEXT;
ALTER TABLE documents ADD COLUMN external_url          TEXT;
ALTER TABLE documents ADD COLUMN wfm_payload           TEXT;

-- ----- NEW TABLES -----

-- Suppliers — full WFM Supplier record. Cost lines may reference
-- a supplier by name; this is the lookup table.
CREATE TABLE IF NOT EXISTS suppliers (
  id              TEXT PRIMARY KEY,
  external_source TEXT,
  external_id     TEXT,
  external_url    TEXT,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_ext
  ON suppliers(external_source, external_id) WHERE external_id IS NOT NULL;

-- Time entries — minimal table for full-fidelity import. Phase-1
-- importer fills it; Pipeline UI doesn't surface it yet.
CREATE TABLE IF NOT EXISTS time_entries (
  id              TEXT PRIMARY KEY,
  external_source TEXT,
  external_id     TEXT,
  staff_user_id   TEXT REFERENCES users(id),
  job_external_id TEXT,                    -- WFM Job UUID; rekey at query time if needed
  date            TEXT,                    -- YYYY-MM-DD
  minutes         INTEGER,
  billable        INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_ext
  ON time_entries(external_source, external_id) WHERE external_id IS NOT NULL;

-- Invoices — minimal table. Pipeline UI doesn't surface it yet.
CREATE TABLE IF NOT EXISTS invoices (
  id                  TEXT PRIMARY KEY,
  external_source     TEXT,
  external_id         TEXT,
  external_url        TEXT,
  wfm_number          TEXT,                -- "INV-0003"
  wfm_type            TEXT,                -- "Final Invoice"
  wfm_status          TEXT,                -- "Approved"
  account_id          TEXT REFERENCES accounts(id),
  contact_id          TEXT REFERENCES contacts(id),
  job_external_id     TEXT,                -- WFM "JobText" cross-reference
  date                TEXT,
  due_date            TEXT,
  amount              REAL,
  amount_tax          REAL,
  amount_including_tax REAL,
  amount_paid         REAL,
  amount_outstanding  REAL,
  description         TEXT,
  wfm_payload         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ext
  ON invoices(external_source, external_id) WHERE external_id IS NOT NULL;

-- Task templates — flat catalog. WFM uses these as building blocks
-- for jobs ("WELDING", "ENGINEERING", etc.). Kept as raw catalog.
CREATE TABLE IF NOT EXISTS wfm_task_templates (
  id              TEXT PRIMARY KEY,
  external_id     TEXT UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Job templates — same idea (NEW MANUFACTURING, REFURB WINCH, etc.).
CREATE TABLE IF NOT EXISTS wfm_job_templates (
  id              TEXT PRIMARY KEY,
  external_id     TEXT UNIQUE,
  name            TEXT NOT NULL,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Categories (the global ones — SPARES / NEW EQUIPMENT / etc.) and
-- lead categories ("3 Opportunity") are reference data we don't need
-- a table for — they're consumed by the Lead/Job mapping in §6.
-- The verbatim string is preserved on every imported row in
-- opportunities.wfm_category and opportunities.wfm_type.
```

---

## 11. Decisions you need to make

Refinements applied (Principles §0): UUIDs Pipeline-only, lose-nothing
via wfm_payload, hybrid Lead/Job. The remaining decisions are smaller:

| # | Question | Recommendation | Your call |
|---|---|---|---|
| 1 | Lead+Job hybrid | ✅ confirmed | yes |
| 2 | Time entries — store raw in `time_entries` | (per Principle 2 — yes, with new table) | |
| 3 | Invoices — store raw in `invoices` | (per Principle 2 — yes, with new table) | |
| 4 | Suppliers — store raw in `suppliers` | (per Principle 2 — yes, with new table) | |
| 5 | SUPPLIES → which transaction_type? | merge into 'spares' + opp note | ✅ confirmed |
| 6 | WARRANTY → which transaction_type? | merge into 'service' + opp note | ✅ confirmed |
| 7 | CYLINDERS → which transaction_type? | merge into 'spares' + opp note | ✅ confirmed |
| 8 | REFURB CYLINDERS → which transaction_type? | merge into 'refurb' + opp note | ✅ confirmed |
| 9 | Hot Sheet column on opportunities | yes (per Principle 2 — promote to typed) | |
| 10 | RFQReceivedDate column on opportunities | yes (per Principle 2 — promote to typed) | |
| 11 | project_manager_user_id on jobs | yes | |
| 12 | Stale-owner handling (people who left) | set owner_user_id=null, log unmatched, raw kept in wfm_payload | |
| 13 | Confirm full WFM Lead.Category list | 1 Identified · 2 Qualifying · 3 Opportunity · 4 Quoted · 5 Won · 6 Lost | ✅ confirmed; mapped in §6a |
| 14 | Drop archived/deleted WFM clients? | NO — import everything, set is_archived/is_deleted columns | |
| 15 | Re-import strategy: full-overwrite vs. last-modified delta? | last-modified delta (DateModifiedUtc → updated_at filter) | |

---

## 12. Importer workflow (preview — not building yet)

Once §11 is signed off, the importer runs in this order:

1. **Build user lookup** — one `/staff.api/list` call, build email→id map and enrich `users` rows with WFM payload.
2. **Suppliers** — `/supplier.api/list` paginated → `suppliers` table.
3. **Task templates** — `/task.api/list` → `wfm_task_templates`.
4. **Job templates** — `/template.api/list` → `wfm_job_templates`.
5. **Custom field definitions** — `/customfield.api/definition` → cached for use in step 8/9.
6. **Clients** — paginated `/client.api/list` → `accounts`.
7. **Contacts** — per-client `/client.api/get/{UUID}` → `contacts`.
8. **Leads** — paginated `/lead.api/list` → `opportunities`. For each lead, also call `/lead.api/get/{UUID}/customfield` and merge into `wfm_payload.customFields` + promote known-useful customs.
9. **Quotes** — paginated `/quote.api/list` → `quotes`. For each quote: `/quote.api/get/{UUID}` for line items + customs.
10. **Jobs** — paginated `/job.api/list`. UPDATE matched opportunities (or synthesize new ones); INSERT a `jobs` row when ClientOrderNumber is set (Principle 3).
11. **Invoices** — paginated `/invoice.api/list` → `invoices`.
12. **Time entries** — paginated `/time.api/list?from=…&to=…` (one date-window per quarter to stay under daily rate limit) → `time_entries`.
13. **Documents** — per-account and per-job document lists; stream binaries to R2; metadata to `documents`.

Idempotent throughout (every entity has external_source + external_id).
Re-runs filter by `DateModifiedUtc > last_sync_at` and skip unchanged rows.

Estimated rate-limit budget at C-LARS scale: ~2k clients × ~3 contacts
each + ~500 leads + ~800 quotes × 1 detail call each + ~200 invoices +
time-entries (~yearly batch) ≈ 6–8k calls — about a daily quota.
Phase-1 importer throttles to ~50/min for safety margin.

---

## 13. Future: full WFM data backup (planning placeholder)

**Status:** not building yet — captured here so we don't lose the idea.

The selective-import workbench at `/settings/wfm-import` covers the
"pull what I need into Pipeline" use case. Separate from that, the
user wants a way to **download a complete backup of every single
thing available in WFM** — a defensive snapshot we can fall back on
if BlueRock loses data, sunsets the v1 API, or we ever leave the
platform. Two shapes are possible; we'd pick one before building.

### Option A — Raw archive (recommended)

A read-only dump of every WFM endpoint into R2, preserving the source
XML/JSON exactly as BlueRock returns it. No mapping, no
interpretation — just bytes.

```
r2://c-lars-pms-docs/wfm-backup/<run-id>/
   manifest.json                    # endpoint list + counts + timing
   clients/list.xml                 # /client.api/list (concatenated pages)
   clients/get/<uuid>.xml           # /client.api/get/<uuid> per client
   clients/documents/<uuid>.xml
   leads/current.xml
   leads/get/<uuid>.xml
   leads/customfield/<uuid>.xml
   quotes/current.xml
   quotes/get/<uuid>.xml
   jobs/current.xml
   jobs/get/<uuid>.xml
   jobs/documents/<uuid>.xml
   tasks/list.xml
   templates/list.xml
   suppliers/list.xml
   suppliers/get/<uuid>.xml
   invoices/current.xml
   invoices/get/<uuid>.xml
   time/list.<from>-<to>.xml        # one file per quarter
   staff/list.xml
   customfields/definition.xml
   categories/list.xml
   documents/<wfm-doc-uuid>/<filename>   # binary files (PDFs, etc.)
```

A `wfm_backup_runs` table records each run: started_at, finished_at,
endpoint_count, error_count, total_bytes, r2_prefix.

A subsequent UI (`/settings/wfm-backup`) lists past runs and surfaces
a "Download as zip" button that streams a tar/zip of the entire
prefix.

### Option B — Structured snapshot

Project every WFM record into a normalized SQLite database, separate
from Pipeline's working DB. Same idea as Pipeline's import, but with
zero mapping/loss — every field of every entity in flat tables. Can
be queried with stock SQLite tooling years later.

This is more work to build (we'd duplicate the import logic for read
fidelity) but produces a friendlier artifact. Probably defer until
Option A is in place.

### Constraints we'll need to think through

- **Rate limit**: 60 calls/min, 5000/day. A full crawl is roughly 
  one daily quota at C-LARS scale. Throttle to ~50/min.
- **Pagination**: list endpoints page; `/current` endpoints don't.
  The dump should preserve pagination as separate files
  (`list-page-1.xml`, etc.) so a re-fetch reproduces what BlueRock
  returned.
- **Documents**: the per-doc binary fetch endpoint isn't probed yet.
  Try `/document.api/get/{UUID}` first; fall back to the WebURL with
  the OAuth token if needed.
- **Worker time limits**: full crawl is too long for a single Pages
  Function (30s wall clock). Either run as a Worker cron split into
  sequential phases (clients → leads → quotes → ...) or trigger from
  a one-shot CLI script (`scripts/wfm/full-backup.mjs`) that streams
  to R2 over many minutes.
- **Cadence**: monthly seems right. Manual button + a scheduled
  monthly cron, retain last 12 runs.

### Decision needed before we build

- Option A vs B (recommendation: A)
- Where the trigger lives: web button vs. CLI script vs. cron
- Retention: how many runs to keep in R2

---

## 14. Real-migration TODO checklist

Stuff that's intentionally **deferred to the real migration cutover**
(once we're done sampling / testing the import workbench against
ROVOP-shaped data and ready to do the full pull). Captured here so it
doesn't fall through the cracks.

### 14.1 Schema migrations needed

One follow-up migration (likely `0069_wfm_custom_field_columns.sql`)
adds the new typed columns from §8 that haven't been built yet:

```sql
-- Quote-level custom date fields (do NOT override valid_until)
ALTER TABLE quotes ADD COLUMN quote_due_date     TEXT;   -- WFM QuoteDueDate
ALTER TABLE quotes ADD COLUMN oc_received_at     TEXT;   -- WFM OCDate
ALTER TABLE quotes ADD COLUMN quoted_delivery    TEXT;   -- WFM QuotedDelivery (free text)
ALTER TABLE quotes ADD COLUMN requested_delivery TEXT;   -- WFM RequestedDelivery (free text)

-- Job-level custom date fields
ALTER TABLE jobs ADD COLUMN oc_received_at TEXT;         -- WFM "Order Confirmation Date"
ALTER TABLE jobs ADD COLUMN ntp_at         TEXT;         -- WFM NoticeToProceedDate

-- Opportunity-level (RFQ funnel timing)
-- Note: opportunities.rfq_received_at and opportunities.is_hot_sheet
-- are already covered by §10's 0064 migration that already shipped.
-- opportunities.customer_po_number already exists in the base schema.
```

### 14.2 Importer extensions

`functions/settings/wfm-import/commit.js` must be extended to:

1. Call `/quote.api/get/<UUID>/customfield` per imported quote and
   populate the new typed columns + `wfm_payload.customFields`.
2. Call `/job.api/get/<UUID>/customfield` per imported job and do the
   same for jobs.
3. Call `/lead.api/get/<UUID>/customfield` per imported lead — populate
   `opportunities.is_hot_sheet` from `Hot Sheet` and `opportunities.rfq_received_at`
   when the lead has a quote with `RFQReceivedDate` set (or move the
   custom to opportunity level if WFM stores it on leads in your tenant —
   our probe shows it's a Quote-level custom in C-LARS, so the
   opportunity-level RFQ timestamp gets sourced from the earliest
   non-null `Quote.RFQReceivedDate` across the opp's quotes).
4. Mirror `Job.Order Confirmation Date` to the parent opportunity's
   `actual_close_date` when that field is currently null.

Throttle the per-record customfield calls — at C-LARS scale this is
~200 quotes + ~150 jobs + ~150 leads = ~500 extra API calls, which fits
inside the 5000/day budget but would saturate the 60/min ceiling without
a sleep loop.

### 14.3 Importer behavior locks (decisions captured)

- **`QuoteDueDate` does NOT override `quotes.valid_until`.** Two distinct
  fields, store separately. (Reverses an earlier draft of §8 that had
  the override; the current Pages Functions importer never built the
  override anyway, so no live-data harm.)
- **Custom value collision**: if both `QuoteNotesExternal` and the
  list-endpoint `Description` are set, the importer appends — does not
  overwrite. Same rule for any multi-line custom that lands in an
  existing typed column.

### 14.4 Pipeline UI follow-on

Once the new columns exist:

- Add `rfq_received_at`, `oc_received_at`, `quote_due_date` to the
  opportunities and quotes detail-page filters.
- Add `oc_received_at`, `ntp_at` to the jobs detail-page filters.
- Surface the four free-text Quote customs (`CustomerPO`,
  `QuotedDelivery`, `RequestedDelivery`, `JobNumber`) in the quote
  detail page header strip — these are useful at-a-glance but
  not filter-worthy.

### 14.5 Backfill strategy

Once the new columns + extended importer are live, **re-import** every
WFM-sourced row to populate the new fields. Idempotent, so this is
safe — the existing rows just get UPDATEd with the new column values.
Plan ~30 minutes of API time for the full backfill given rate limits.

### 14.6 Backup snapshot before cutover

Before the real-migration full pull, take one **complete data backup
run** per §13 (Option A — raw archive). That gives us a defensive
snapshot of every WFM endpoint at cutover time, separate from
Pipeline's interpretation. Build the §13 mechanism first if it isn't
already in place.

---

*End of v2 mapping draft. Mark up the "Your call" column in §11 and
ping me when ready — I'll roll the answers into a final mapping
spec, then build the importer.*
