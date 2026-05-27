# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
