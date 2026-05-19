# MRPeasy → Pipeline extraction

**Status:** Phase 1 scaffolding — raw export first, mapping later.
**Last updated:** 2026-05-02
**Context:** MRPeasy is the MRP/ERP C-LARS used **before** WorkflowMax.
The account is still active but **frozen** — no new data goes in. We
want everything out of it, archived safely, then selectively mapped
into Pipeline later (same shape as the WFM workbench).

This doc is the MRPeasy analog of `docs/wfm-mapping.md`.

---

## 0. Two-phase plan (per user direction)

> "i want to have access to all of it." + "raw export first, then mirror."

**Phase 1 — Raw export (build now).** Pull *every* MRPeasy entity
verbatim into R2 as JSON, no Pipeline mapping, no interpretation. This
is the defensive archive — if MRPeasy ever sunsets the account or the
plan lapses, the data is already ours. It also reveals the real
record shapes so Phase 2 mapping is grounded in actual data, not
guesses.

**Phase 2 — Mirror the WFM workbench (later).** Once the raw shapes
are known, build `/settings/mrpeasy-import` with the same
sample → search → selective-import → run-history machinery the WFM
importer has, including smart-match/claim so MRPeasy accounts merge
with WFM-imported and Pipeline-native rows instead of duplicating.

Nothing in Phase 1 forecloses Phase 2 — it's purely additive.

---

## 1. API facts (researched 2026-05-02)

| Thing | Value |
|---|---|
| Base URL | `https://app.mrpeasy.com/rest/v1/` (sample client authoritative; `api.mrpeasy.com` cited in some docs — probe will confirm which the C-LARS account uses) |
| Auth | **HTTP Basic** — `Authorization: Basic base64(api-key + ':' + api-secret)` |
| Credential source | MRPeasy → **Settings → Integration → API access** (admin generates key + secret there) |
| Plan requirement | **Unlimited plan** — lower tiers do not expose the full REST API |
| Format | **JSON** (contrast WFM/BlueRock's XML) |
| Methods we use | **GET only** (API also supports POST/PUT/DELETE; we never write) |
| Pagination | `offset` + `limit` query params, **max 100 / page**. Response carries `Content-Range: items 0-99/1476`; HTTP **206** = partial content, **200** = last/whole page |
| **Rate limit** | **One request at a time per account.** HTTP **429** = "another request is running at the same time." There is *no* concurrency budget — every call must be **strictly serial** with retry-on-429. This is the single most important constraint for the exporter. |
| Access | Read-only for our purposes; ~53 inbound streams documented |

### Why this is far easier than WFM

The entire WFM pain surface — OAuth2, rotating refresh tokens, the
reconnect dance, XML parsing, the `wfm_credentials` token-refresh
machinery — **does not exist here**. MRPeasy is a static api-key +
secret, set once. The only real constraint is the serial-request
rule.

---

## 2. Entity catalog (target — confirm via probe)

MRPeasy documents ~53 read streams. The ones that matter for Pipeline,
plus everything else for the archive. Exact endpoint paths are
confirmed by `functions/settings/mrpeasy-import/probe.js` against the
live account (it hits each candidate with `limit=1` and reports
HTTP status + `Content-Range` total).

**CRM-relevant (Phase 2 mapping candidates):**

| MRPeasy entity | Candidate path | → Pipeline (Phase 2) |
|---|---|---|
| Customers | `/customers` | accounts |
| Customer contacts | `/customers` (nested) or `/customer-contacts` | contacts |
| Customer orders | `/customer-orders` | opportunities (won) / quotes |
| Customer order products | nested in order | quote_lines |
| Quotations / RFQ | `/quotations` or `/rfq` | opportunities / quotes |
| Vendors | `/vendors` | suppliers |
| Vendor contacts | `/vendors` (nested) | (supplier contacts) |
| Items / products | `/items` | (parts catalog — TBD) |
| Sales invoices | `/invoices` | invoices |
| Invoice products | nested in invoice | (invoice lines) |

**Archive-only (Phase 1 only, no Pipeline target yet):**
manufacturing orders + parts/lots/operations, BOMs + components,
routings + operations, work stations + types, stock items + lots +
lot locations, serial numbers, units of measurement, shipments +
products, RMAs, purchase orders + bills, activities, user actions,
parameters, relations + relation values.

> The probe self-discovers which of these paths actually resolve for
> the C-LARS account. Treat the table above as a hypothesis; the
> probe output is truth.

---

## 3. Phase 1 deliverables (this build)

| File | Role |
|---|---|
| `migrations/0071_mrpeasy_credentials.sql` | single-row creds table (mirrors `wfm_credentials`) |
| `functions/lib/mrpeasy-client.js` | Basic-auth client; **serial-only**; 429 retry; Content-Range pagination; `fetchAll()` |
| `functions/settings/mrpeasy-import/index.js` | Phase-1 workbench shell |
| `functions/settings/mrpeasy-import/set-credentials.js` | store api-key/secret + connection test |
| `functions/settings/mrpeasy-import/probe.js` | entity-discovery probe |
| `functions/settings/mrpeasy-import/export.js` | raw export → R2 |

R2 layout for an export run:

```
r2://c-lars-pms-docs/mrpeasy-export/<run-id>/
   manifest.json          # entity list, per-entity record count, timing, errors
   customers.json          # full array, all pages concatenated
   customer-orders.json
   vendors.json
   items.json
   ... (one file per discovered entity)
```

---

## 4. Prerequisites (BLOCKING — need from user)

1. **Plan tier** — confirm the C-LARS MRPeasy account is on the
   **Unlimited** plan. Without it the REST API returns nothing and
   the connection test will fail.
2. **API credentials** — api-key + api-secret from MRPeasy
   **Settings → Integration → API access**. Paste into the
   `/settings/mrpeasy-import` connect form (stored in
   `mrpeasy_credentials`, single row).

Until both are in, the workbench renders and the code is deployed but
the probe/export cannot run (no creds → connection test fails fast
with a clear message).

---

## 5. Phase 2 (later — NOT this build)

Mirror `functions/settings/wfm-import/*`:
- sample / structured search / selective import / run history
- smart-match + auto-cascade so MRPeasy customers claim existing
  WFM-imported / Pipeline-native accounts by name (external_source
  = `mrpeasy`, external_id = MRPeasy object id) rather than
  duplicating ROVOP-style records that exist in both systems
- per-entity field mapping table (the §1–§10 treatment
  `wfm-mapping.md` got), grounded in the real shapes the Phase 1
  raw export reveals

Decisions deferred to Phase 2 kickoff:
- dedupe strategy when a customer exists in BOTH MRPeasy and WFM
- whether MRPeasy customer-orders become opportunities, quotes, or
  both (depends on how C-LARS used MRPeasy's sales module)
- items/product catalog — import into a parts table or leave in the
  raw archive only
