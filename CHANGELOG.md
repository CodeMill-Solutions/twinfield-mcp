# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-05-27

### Added

- `process_sales_invoice` — book a sales invoice via Twinfield's `VRK`
  daybook. Composes the `<transaction>` with `<invoicenumber>`, optional
  `<duedate>`, a `type="total"` debtor line, and one or more revenue lines
  with optional `<vatcode>` (Twinfield auto-generates the VAT booking).
- `process_purchase_invoice` — symmetric tool for the `INK` daybook (total
  on creditor, cost lines with purchase-side VAT codes like `IH`/`IL`).
- `deactivate_dimension` — soft-delete a customer/supplier/cost-centre/
  project by sending `<dimension status="inactive">`. Twinfield requires
  the `<name>` element on every dimension upsert; the tool reads the
  current name first and preserves it so callers don't have to.

### Fixed

- **`get_gl_accounts` was missing ~half the chart of accounts.** v0.3.0
  only queried Twinfield's `BAS` (balance-sheet) dimension type, hiding
  every `PNL` (profit-and-loss) account — including all revenue and
  expense GLs. v0.4.0 queries both in parallel and tags each entry with a
  `glType` field (`BAS` or `PNL`). A new optional `glType` parameter
  filters to one side when desired. On a typical Dutch RGS template this
  bumps the result from ~150 to ~340 entries.

### Notes on Twinfield invoice quirks (discovered + documented in code)

- Sales VAT codes (`VH`, `VL`, `VN`, …) are NOT interchangeable with
  purchase VAT codes (`IH`, `IL`, `IN`, …). Twinfield rejects with a clear
  message — but the prefix convention is V*erkoop* / I*nkoop*.
- Dimension deactivation accepts the `status="inactive"` attribute on
  `<dimension>` but still requires `<name>` (otherwise: "Naam moet worden
  ingevuld"). The `<inactive>` element variant is rejected like `<inuse>`.
- Revenue / cost GL accounts live under dimension type `PNL`, not `BAS`.
  A typical sales invoice books its total line to a `BAS` debtor account
  (1300) and its detail lines to `PNL` revenue accounts (e.g. 8020 "Omzet
  diversen"). Twinfield's `_dimensiontype` attribute on read responses
  confirms which type each account belongs to.

## [0.3.0] - 2026-05-27

### Added

- **Write tools** — first three writes against the Twinfield ProcessXml endpoint:
  - `upsert_customer` (`<dimensions><dimension type="DEB">`) — create or
    update a customer. Idempotent on `<code>`. Office-configured code
    pattern is enforced server-side and surfaced verbatim on error.
  - `upsert_supplier` (`<dimensions><dimension type="CRD">`) — same for
    suppliers.
  - `process_journal` (`<transaction destiny="…">`) — post a general
    journal entry (memoriaal). Defaults to `destiny="temporary"` so the
    entry lands as a draft that can be reviewed and finalised in the
    Twinfield UI; pass `destiny="final"` to commit immediately. Validates
    debit/credit balance client-side and surfaces nested per-field errors
    (e.g. `lines.line[0].dim1: Dimensie 99999 komt niet voor …`).
- `get_office` — read full details for a single office (currencies, VAT/CoC
  numbers, default bank, region, address, fiscal config, …). Returns a
  curated summary plus the full raw response under `details`.
- `padDimensionCode(code, width=4)` exported from `twinfield-client` — works
  around Twinfield's read-write inconsistency where reads return `110` but
  writes require the storage form `0110`. Applied automatically by
  `process_journal` to all `dim1`/`dim2`/`dim3` values.

### Notes on Twinfield write quirks (discovered + documented in code)

- The transaction draft attribute is **`destiny`** (`temporary`/`final`),
  not `status`. Wrong attribute → "Incorrecte XML - de bestemming is
  ongeldig."
- `<inuse>` is NOT accepted on dimension upserts — Twinfield rejects it
  with "Het element 'inuse' mag niet worden aangeleverd." The
  active/inactive state is managed via a separate operation.
- `<read><type>office>` requires BOTH `<office>` (context) and `<code>`
  (identifier), even when they refer to the same office. Without `<code>`
  Twinfield returns the misleading "U hebt geen toegang tot deze
  administratie."
- Field-level write errors live on the offending sub-element
  (e.g. `line.dim1.@_msg`), not on the parent line. Our normalizer
  recursively collects every `@_msg` in the response.

## [0.2.0] - 2026-05-27

### Added

- `callBrowse({ office, code, columns })` on `TwinfieldClient` — generic
  helper for Twinfield's `<columns code="…">` browse-query family.
  Composes the column XML, dispatches via `callProcessXml`, and normalises
  the `<browse><th><td>…<tr><td>…` shape into typed `{ headers, rows, total }`.
- Three transaction read tools on top of `callBrowse`:
  - `get_transactions` — generic listing with optional daybook /
    year-period / counterparty filters.
  - `get_sales_invoices` — pre-set with daybook `VRK`; supports `openOnly`
    to keep only unpaid lines (`matchStatus === "available"`).
  - `get_purchase_invoices` — pre-set with daybook `INK`; supports
    `openOnly` likewise.
- `BrowseColumn`, `BrowseRow`, `BrowseResult` exports for downstream tools.

### Notes on Twinfield browse-engine quirks (discovered + documented in code)

- Amount fields ONLY work with the `…valuesigned` suffix
  (`fin.trs.line.valuesigned`, `fin.trs.line.openbasevaluesigned`).
  Un-signed variants (`basevalue`, `value`, `basedebet`) trigger server
  faults or "Veld bestaat niet" errors.
- `fin.trs.line.dim1` is incompatible with `fin.trs.line.dim2` in browse 100
  — we read only `dim2` (counterparty).
- `fin.trs.head.date` does not accept `<operator>` filtering; we filter by
  `fin.trs.head.yearperiod` (`YYYY/PP` format) instead.
- `matchstatus` filtering at the column level triggers server faults —
  `openOnly` is applied as a client-side post-filter.

## [0.1.1] - 2026-05-27

### Changed

- Scrubbed a real Twinfield office code that had leaked into README examples
  and one JSDoc comment in `src/tools/dimensions.ts`. Replaced with neutral
  placeholders (`your-office-code`, `OFFICE_CODE_A`, etc.). No runtime
  behaviour change.

## [0.1.0] - 2026-05-27

Initial public release — read-only preview.

### Added

- OAuth2 / OpenID Connect authentication with refresh-token grant, automatic
  access-token cache, and cluster URL discovery via Twinfield's
  `accesstokenvalidation` endpoint.
- One-time interactive authorization script (`npm run authorize`) that drives
  the authorization code flow on `http://localhost:8765/callback` and writes
  long-lived credentials to `~/.twinfield/credentials.json` (mode 0600).
- Multi-office credentials file with the same path-resolution precedence as
  yuki-mcp's keys file.
- `TwinfieldClient.callProcessXml` — SOAP envelope builder with the OAuth2
  `<Header>` shape (`AccessToken` + `CompanyCode` + nillable `CompanyId`),
  `xmlRequest` escape handling, and double-parsing of the string-typed result.
- Fair-use awareness: HTTP 429 retry honouring `Retry-After`, rate-limit
  headers surfaced in error messages.
- 8 MCP tools:
  - `whoami`, `reload_credentials` (auth / setup)
  - `list_offices`
  - `get_customers`, `get_suppliers`, `get_gl_accounts`,
    `get_cost_centers`, `get_projects` (dimensions)
- Standalone CLI probes in `scripts/`: `authorize.ts`, `whoami.ts`,
  `list-offices.ts`, `explore.ts`.
- GitHub Actions workflow for tag-driven npm publishing.

### Known limitations

- Browse-style reads (`get_transactions`, `get_sales_invoices`,
  `get_purchase_invoices`) require the `<columns>` query family and are
  deferred to v0.2.
- `get_office`, `get_period_table`, `get_start_balances` need different
  Twinfield services than ProcessXml and are deferred.
- All write tools (`process_journal`, invoice creation, document upload) are
  deferred to v0.3+ after the read-only path is fully proven.
