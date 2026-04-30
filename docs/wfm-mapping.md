# WFM → Pipeline schema mapping

**Status:** Phase 1 draft — schema sign-off.
**Last updated:** 2026-04-30
**Inputs:** `docs/wfm-api-probe-results.md` (real C-LARS sample data) +
`migrations/0001_initial.sql` (current Pipeline schema).

This doc maps every WFM entity onto Pipeline, with field-by-field
correspondences and a "Decisions" section at the bottom. Anything
controversial is flagged inline. Once you've signed off, the Phase-1
importer follows the table mechanically.

---

## Big picture

| WFM entity | → Pipeline | Notes |
|---|---|---|
| Client | accounts | 1:1, idempotent on UUID |
| Client.Contacts.Contact[] | contacts | Walked via `/client.api/get/{UUID}` |
| Lead | opportunities | Pre-quote / early-stage |
| Job | opportunities (won) ± jobs | See §3 (the big decision) |
| Quote | quotes (+ cost_builds) | Lines fetched via `/quote.api/get/{uuid}` |
| Staff | users | Match by email — no rekey table needed |
| Custom Field Def | metadata only | Used to interpret per-record custom values |
| Category (lead) | opportunities.stage / .transaction_type | See §6 |
| Task (template) | _skip_ | WFM-internal "WELDING / ENGINEERING" task names |
| Template (job) | _skip_ | WFM-internal job-template names |
| Supplier | _skip for v1_ | No Pipeline table; cost_lines has free-text supplier |
| Time entry | _skip_ | Operational, not CRM |
| Invoice | _skip_ | Operational, not CRM |
| Document (client + job) | documents (in R2) | Walked from parent records |

---

## 1. Clients → Accounts

```
WFM Client                            Pipeline accounts
─────────────────────────             ─────────────────────────
UUID                              →   external_id (+ external_source='wfm')
Name                              →   name
Phone                             →   phone
Address+City+Region+PostCode+Country  →   address_billing (joined with newlines)
PostalAddress+PostalCity+...      →   address_physical (if different)
Website                           →   website
AccountManager (text name)        →   owner_user_id (match by name → users; null if no match)
WebURL                            →   notes (appended as "WFM: <url>")
Email                             →   _drop_ (rarely populated; per-person email lives on contacts)
IsArchived / IsProspect           →   _skip for v1_ (Pipeline has no archived/prospect flag)
ReferralSource                    →   _drop for v1_
ExportCode                        →   _drop_
Type{Name, CostMarkup, ...}       →   _drop_ (mostly empty in probe sample)
Fax                               →   _drop_
```

**Sample (ROVOP Inc):**
```
external_id      = a01f3597-afa9-4213-92d4-aaae532bc001
external_source  = wfm
name             = ROVOP Inc
phone            = (empty)
address_billing  = ROVOP Americas LLC\n2000 W. Sam Houston Pkwy\nSuite 1100\nHouston, Texas 77042\nUnited States of America
address_physical = 1121 Decker Drive\nMandeville, LA 70471\nUnited States of America
website          = (empty)
owner_user_id    = (empty — no AccountManager set on this record)
notes            = WFM: https://app.workflowmax.com/organizations/.../clients/.../details
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
Salutation, Addressee   →   _drop_ (mail-merge fields)
```

**Importer flow:** two-pass.
1. Walk `/client.api/list` paginated, create accounts.
2. For each account, call `/client.api/get/{UUID}` to read the Contacts
   array, create contacts FK'd to the new Pipeline account.

ROVOP Inc had 4 contacts: Doug Potter (Asset Manager), Reed Curry
(Project Manager), Stuart Campbell (Asset & Technical support), Mike Smith.

---

## 3. Leads + Jobs → Opportunities (THE big decision)

In WFM:
- **Lead** is pre-quote: name, value, category, owner, status (Current/Won/Lost). The "deal in flight" entity.
- **Job** is post-quote: client, manager, type, state (PLANNED/PRODUCTION/...). The "production work" entity.

In Pipeline:
- `opportunities` is the spine — it covers the *entire* deal lifecycle (early → quoted → closed-won → handed off). `stage` tracks where the deal is.
- `jobs` is just the post-won commercial hand-off (PO, OC, NTP, authorization). It FK's back to the originating opportunity.

### Three options

**(A) Both into opportunities only.** WFM Lead → opportunity. WFM Job
→ opportunity (synthetic if no matching Lead, or merge onto an
existing matching Lead-derived opportunity). No `jobs` rows. Simplest
data model.

**(B) Lead → opportunity, Job → opportunity + jobs.** Each WFM Job
also gets a Pipeline `jobs` row to capture project-management info
(state, type, manager, dates). Most expressive, but pulls operational
data into a CRM that wasn't designed for it.

**(C) Recommended: hybrid.** WFM Lead → opportunity. WFM Job → opportunity
(stage='closed_won' or later) + a `jobs` row *only if* the WFM Job has
a real customer PO / order number. Skips the project-tracking churn for
internal-only jobs (e.g. "INTERNAL ENG"), keeps the commercial-handoff
record for real customer jobs.

### Lead → opportunity field mapping

```
WFM Lead                  Pipeline opportunities
─────────────────         ─────────────────────────
UUID                  →   external_id (+ external_source='wfm-lead')
Name                  →   title
Description           →   description
State (Current/Won/Lost) →   stage (see §6 stage map)
EstimatedValue        →   estimated_value_usd
Date                  →   created_at (server preserves WFM-side timestamp)
DateWonLost           →   actual_close_date (when state ≠ Current)
Category              →   transaction_type (see §6 category map)
Client.UUID           →   account_id (re-key from accounts.external_id)
Contact.UUID          →   primary_contact_id (re-key from contacts.external_id)
Owner.UUID            →   owner_user_id (re-key from users.email matched to WFM Staff.Email)
Dropbox               →   _drop_ (deprecated WFM feature)
```

Sample lead → opportunity:
```
title          = WROV LARS
description    = (empty)
transaction_type = eps    (from Category="3 Opportunity" + WROV LARS naming → see §6)
stage          = qualified  (from Lead.State="Current" + Category="3")
estimated_value_usd = 1200000
account_id     = (Pipeline ID for "Saab")
primary_contact_id = (Pipeline ID for "Mike Thomson")
owner_user_id  = (Pipeline ID for "Wes Yoakum" matched on email)
external_id    = a099809b-c501-4307-9fb7-7cd7b48653be
external_source = wfm-lead
```

### Job → opportunity (+ jobs) field mapping

If the WFM Job has a matching Lead (via approved-quote linkage),
**update** the existing opportunity to stage='closed_won' rather than
creating a new one. If no matching Lead, **synthesize** a new
opportunity at stage='closed_won'.

```
WFM Job                       Pipeline opportunities (when synthesizing)
─────────────────             ─────────────────────────
UUID                      →   external_id (+ external_source='wfm-job')
Name                      →   title
Description               →   description
Client.UUID               →   account_id (re-key)
Type ("NEW EQUIPMENT" etc) →   transaction_type (see §6)
State                     →   stage ('closed_won' typically)
StartDate                 →   actual_close_date (proxy for "deal closed")
ClientOrderNumber         →   (passed to jobs.customer_po_number)
ApprovedQuoteUUID         →   _used to link existing quote_
Manager.UUID              →   _no Pipeline column; see Decisions §11_
DueDate                   →   _drop_ (operational, lives in Monday/Smartsheet)
DateModifiedUtc           →   updated_at
WebURL                    →   notes
```

If we ALSO create a `jobs` row (option C, when ClientOrderNumber is set):

```
WFM Job                   Pipeline jobs
─────────────────         ─────────────────────────
UUID                  →   external_id (+ external_source='wfm-job')   ← needs new column
ID (C300, INTERNAL)   →   number (or notes)
Name                  →   title
Type                  →   job_type
State                 →   status (PLANNED→'created', PRODUCTION→'handed_off', etc — see §7)
ClientOrderNumber     →   customer_po_number
StartDate             →   handed_off_at
Manager.UUID          →   handed_off_by_user_id (or new column?)
WebURL                →   notes
```

### Open Q on `jobs` table:
- Need to add `external_source` + `external_id` columns to `jobs` for idempotent re-imports.
- Optional: add `project_manager_user_id` to preserve WFM Job.Manager.

---

## 4. Quotes → Quotes (+ cost_builds)

```
WFM Quote                       Pipeline quotes
─────────────────               ─────────────────────────
UUID                        →   external_id (+ external_source='wfm')
ID (Q25008)                 →   notes_internal (cross-reference; Pipeline auto-generates Q-2026-NNNN)
Type ("Quote")              →   quote_type (defaults to opportunity's transaction_type)
State (Draft/Issued)        →   status (see §7)
Name                        →   title
Description                 →   description
Date                        →   created_at
ValidDate                   →   valid_until
Amount                      →   subtotal_price
AmountTax                   →   tax_amount
AmountIncludingTax          →   total_price
EstimatedCost*              →   _separate cost_build row, total_cost = EstimatedCost_
LeadUUID                    →   opportunity_id (re-key from opportunities.external_id)
JobUUID                     →   (alternative re-key path; prefer LeadUUID if both present)
Client.UUID                 →   _set on parent opportunity, not on quote_
Contact.UUID                →   _set on parent opportunity, not on quote_
OptionExplanation           →   notes_customer
Budget                      →   _drop_
```

### Quote lines (`quote_lines`) require a separate call

The list endpoints don't include line items. To get them, the importer
needs `/quote.api/get/{UUID}` per quote — the response shape is
`DetailedQuote` per the OAS spec (with `Costs` and `Tasks` arrays).

That's one extra API call per quote. With 60 calls/min and a few
hundred quotes, this is one batch of work overnight, well within
rate limits.

### Sample quote → quote
```
external_id    = a02af19e-cc09-4919-84d3-10e49964a629
external_source = wfm
title          = Squatty Dual HPU
opportunity_id = (Pipeline ID for the Helix Robotics deal)
quote_type     = eps    (matches opportunity.transaction_type)
status         = submitted    (from State='Issued')
subtotal_price = 596000.0000
tax_amount     = 0
total_price    = 596000.0000
valid_until    = 2025-11-21T00:00:00
notes_internal = "WFM ID: Q25011\nDescription: Due March 1st to ship to Norway\nGoes with two blue 9966M A-Frames..."
```

---

## 5. Staff → Users (lookup-only)

Pipeline already has `users` populated from Cloudflare Access (each
team member has a Pipeline user row keyed off their `c-lars.com`
email). The importer doesn't *create* users — it just **builds an
email-keyed lookup table** to re-key WFM Staff.UUID references on
incoming Lead/Job records.

```
WFM Staff                Pipeline users (lookup only)
─────────────────        ─────────────────────────
Email                →   match against users.email (case-insensitive)
                          → users.id is the value to use anywhere
                            WFM had Staff.UUID
```

### Edge cases
- **Non-person staff** (e.g. "Accounts Payable" → `ap@c-lars.com`) — these *do* match a Pipeline user (`ap@c-lars.com` exists per the probe), so no special handling needed.
- **Stale staff** (people who left) — if their email no longer matches a Pipeline user, set `owner_user_id = null` on the opportunity. The importer logs the unmatched names so you can decide later.

---

## 6. Stage / Category / Type mapping

WFM has **two** classification axes that both feed into Pipeline:

### 6a. WFM Lead.Category → Pipeline opportunities.stage

Categories observed in the probe:
- "3 Opportunity"
- "4 Quoted"

The number prefix suggests a sequence: 1, 2, 3, 4, 5, 6 — likely identifying / qualifying / opportunity / quoted / won / lost. **You'll need to confirm the full list** from inside WFM (probe didn't see all of them because we only sampled current leads).

Tentative map (please correct):
```
WFM Category              Pipeline stage (transaction_type='spares', as example)
─────────────────         ─────────────────────────
"1 Identified"        →   identified
"2 Qualifying"        →   qualifying
"3 Opportunity"       →   qualified
"4 Quoted"            →   quote_submitted
"5 Won"               →   closed_won
"6 Lost"              →   closed_lost
```

### 6b. WFM Job.Type AND WFM Categories list → Pipeline opportunities.transaction_type

The `category.api/list` returned EIGHT global categories — these are
NOT lead-stage categories, they're transaction-type categories:

```
WFM Category (global)        Pipeline transaction_type
─────────────────            ─────────────────────────
NEW EQUIPMENT            →   eps
SPARES                   →   spares
REFURBISHMENT            →   refurb
SERVICE                  →   service
SUPPLIES                 →   ?? (extend enum or merge into spares)
WARRANTY                 →   ?? (extend or merge into service)
CYLINDERS                →   ?? (probably under spares)
REFURB CYLINDERS         →   ?? (probably under refurb)
```

WFM Job.Type strings ("NEW EQUIPMENT", etc.) match this list verbatim.

### Decisions §11 includes:
- Confirm the lead-Category list (1..6 names)
- Decide on SUPPLIES, WARRANTY, CYLINDERS, REFURB CYLINDERS handling

---

## 7. State / Status mapping

### WFM Lead.State → opportunities.stage modifier
- `Current` → keep the Category-derived stage
- `Won`     → override to `closed_won`
- `Lost`    → override to `closed_lost`

### WFM Quote.State → quotes.status
```
Draft       → draft
Issued      → submitted
Accepted    → accepted        (didn't see in probe but listed in OAS)
Declined    → rejected
Archived    → expired         (or 'superseded' if there's a newer revision)
```

### WFM Job.State → jobs.status (only if creating jobs row)
```
PLANNED         → created
PRODUCTION      → handed_off (already in Monday / Smartsheet)
COMPLETED       → handed_off + actual_close_date set on parent opp
CANCELLED       → cancelled
```

---

## 8. Custom fields

10 custom field definitions found in the probe. The values are
fetched per-record via `/{entity}.api/get/{UUID}/customfield`.

```
Custom field           Type       Applies to       Pipeline disposition
─────────────────────  ─────────  ───────────────  ─────────────────────────
MATERIAL DESC          Text       JobCost          cost_lines.notes (appended)
REV                    Text       JobCost          cost_lines.notes (appended)
DRAWING REFERENCE      Text       JobCost          cost_lines.notes (appended)
TAG                    Text       JobCost          cost_lines.notes (appended)
Delivery Address       Multi-line Job              quotes.delivery_terms (per quote on the job)
QuoteNotesExternal     Multi-line Quote            quotes.notes_customer (append)
QuoteDueDate           Date       Quote            quotes.valid_until (override if set)
QuoteTerms             Multi-line Quote            quotes.payment_terms (or notes_customer)
Hot Sheet              Checkbox   Lead             ???   (open — see Decisions §11)
RFQReceivedDate        Date       (truncated)      ???   (open — see Decisions §11)
```

---

## 9. Documents

Documents are nested per Client and per Job. The probe confirmed
both endpoints return 200 (with empty `Documents` element on the
sample records, meaning ROVOP and INTERNAL just don't have any).

### Strategy
For each account that has WFM documents:
1. List via `/client.api/documents/{UUID}`
2. For each doc, fetch the binary (separate endpoint — TBD)
3. Upload to R2 at `accounts/<pipeline_account_id>/<wfm_doc_uuid>-<safe_name>`
4. Insert a `documents` row pointing to the parent account

Same for jobs. **Open Q (deferred to importer build):** what's the
binary-fetch endpoint? The OAS spec lists `/client.api/document` /
`/job.api/document` for *uploading*, but the *download* endpoint
isn't obvious from the operation list. Probably `/document.api/get/{UUID}`
or it returns the binary directly off the metadata link.

---

## 10. Required schema changes

Minimum to support the import:

```sql
-- migrations/0062_wfm_import_support.sql
-- Allows idempotent re-imports of WFM jobs (analogous to existing
-- external_id columns on accounts/contacts/opportunities/quotes).
ALTER TABLE jobs ADD COLUMN external_source TEXT;
ALTER TABLE jobs ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ext
  ON jobs(external_source, external_id)
  WHERE external_id IS NOT NULL;
```

Optional, depends on §11 decisions:
```sql
-- If we decide to preserve WFM Lead.Hot Sheet
ALTER TABLE opportunities ADD COLUMN is_hot_sheet INTEGER NOT NULL DEFAULT 0;

-- If we decide to preserve WFM RFQReceivedDate as its own column
ALTER TABLE opportunities ADD COLUMN rfq_received_at TEXT;

-- If we extend transaction_type with new enums
-- (no schema change — transaction_type is TEXT, enum lives in app code)

-- If we want to track WFM Job.Manager separately
ALTER TABLE jobs ADD COLUMN project_manager_user_id TEXT REFERENCES users(id);
```

---

## 11. Decisions you need to make

These all influence the importer; flag your call on each.

| # | Question | Recommendation | Your call |
|---|---|---|---|
| 1 | Lead+Job vs. just Lead | Option C (hybrid — `jobs` row only when there's a customer PO) | |
| 2 | Time entries | Skip | |
| 3 | Invoices | Skip | |
| 4 | Suppliers | Skip for v1 (cost_lines.supplier stays free-text) | |
| 5 | SUPPLIES → which transaction_type? | merge into 'spares' | |
| 6 | WARRANTY → which transaction_type? | merge into 'service' | |
| 7 | CYLINDERS → which transaction_type? | merge into 'spares' | |
| 8 | REFURB CYLINDERS → which transaction_type? | merge into 'refurb' | |
| 9 | Hot Sheet (Lead checkbox) | add `opportunities.is_hot_sheet` column | |
| 10 | RFQReceivedDate (Lead date) | add `opportunities.rfq_received_at` column | |
| 11 | WFM Job.Manager mapping | add `jobs.project_manager_user_id` column | |
| 12 | Stale-owner handling (people who left) | set owner_user_id=null, log unmatched | |
| 13 | Confirm full WFM Lead.Category list | (need to inspect WFM directly — probe only saw "3 Opportunity" and "4 Quoted") | |
| 14 | account.notes WFM-link append | yes, helpful for cross-reference | |
| 15 | Drop archived/deleted WFM clients? | yes, skip (IsArchived='Yes' or IsDeleted='Yes') | |

---

## 12. Importer workflow (preview — not building yet)

Once decisions are made, the importer runs in this order:

1. **Build user lookup** (one call to `/staff.api/list`, build email→id map)
2. **Import clients** (paginated `/client.api/list`, INSERT/UPDATE accounts by external_id)
3. **Import contacts** (per-account `/client.api/get/{UUID}`, INSERT contacts)
4. **Import leads** (paginated `/lead.api/list`, INSERT opportunities)
5. **Import quotes** (paginated `/quote.api/list`, INSERT quotes)
6. **Per-quote line items** (per-quote `/quote.api/get/{UUID}` for Costs/Tasks → quote_lines + cost_builds)
7. **Import jobs** (paginated `/job.api/list`, UPDATE matched opportunities or synthesize new ones; INSERT jobs rows where applicable)
8. **Per-record custom fields** (per-quote and per-lead customfield calls; merge values into target fields)
9. **Documents** (per-account and per-job document lists; stream binaries to R2)

Idempotent throughout (every entity has external_source + external_id);
re-running picks up changes via `updated_at` and ignores anything
that hasn't moved.

Estimated rate-limit budget at C-LARS scale: ~2000 clients × ~3
contacts each + ~500 leads + ~800 quotes × 1 line-item call each =
roughly 5000 calls — fits in one daily window. Phase-1 importer
will throttle to ~50/min to stay safely under 60/min.

---

*End of mapping draft. Mark up the "Your call" column in §11 and
ping me when ready — I'll roll the answers into a final mapping
spec, then build the importer.*
