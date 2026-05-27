# twinfield-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects AI agents to [Twinfield](https://www.twinfield.com) accounting via Twinfield's SOAP API.

Built with Node.js, TypeScript, and [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

> **Status: v0.2.0 — read-only.** Covers authentication, office discovery, dimension reads (customers, suppliers, GL accounts, cost centres, projects), and browse-based transaction reads (general transactions, sales invoices, purchase invoices). Write tools are planned for v0.3+.

---

## Installation

```bash
npm install @codemill-solutions/twinfield-mcp
```

Then add it to your MCP host configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "twinfield": {
      "command": "node",
      "args": ["node_modules/@codemill-solutions/twinfield-mcp/dist/index.js"],
      "env": {
        "TWINFIELD_OFFICE_CODE": "your-office-code"
      }
    }
  }
}
```

The actual OAuth2 credentials (client id, client secret, 25-year refresh token) live in `~/.twinfield/credentials.json` rather than environment variables — see [Setup](#setup) below.

---

## Prerequisites

- Node.js 20+
- A Twinfield account with API access enabled
- An OpenID Connect client registered via the [Twinfield Developer Portal](https://developers.twinfield.com)
  - **Authorization flow:** authorization code
  - **Access token type:** JWT
  - **Redirect URL:** `http://localhost:8765/callback`
  - **Scopes that will be requested:** `openid twf.user twf.organisation twf.organisationUser offline_access`

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Run the one-time authorization

```bash
npm run authorize
```

The interactive script:

1. Asks for `client_id`, `client_secret`, and the office code (CompanyCode) you want to associate.
2. Opens your browser to the Twinfield login page on `https://login.twinfield.com`.
3. Receives the authorization code on `http://localhost:8765/callback`.
4. Exchanges the code for an access + refresh token.
5. Calls Twinfield's access-token-validation endpoint to discover the per-account cluster URL.
6. Writes `~/.twinfield/credentials.json` (mode 0600) with the office entry.

Twinfield refresh tokens have a 25-year TTL, so this is a one-time setup. After this step the MCP server can authenticate non-interactively forever (or until you reset the client secret in the developer portal).

### 3. Build

```bash
npm run build
```

### 4. Connect to an MCP host

```json
{
  "mcpServers": {
    "twinfield": {
      "command": "node",
      "args": ["/absolute/path/to/twinfield-mcp/dist/index.js"],
      "env": {
        "TWINFIELD_OFFICE_CODE": "your-office-code"
      }
    }
  }
}
```

---

## Multi-office support

A single OAuth client typically grants access to **all offices (CompanyCodes) within one organisation**. Call `list_offices` to discover which office codes you can use. Every read tool accepts an `office` parameter that overrides the default for that one call.

If you manage **multiple organisations** (each with its own client_id/client_secret pair), supply a JSON file that maps every office code to its OAuth2 credentials. The server then authenticates per office automatically — no single shared refresh token required.

### Credentials file format

```json
{
  "OFFICE_CODE_A": {
    "clientId": "...",
    "clientSecret": "...",
    "refreshToken": "..."
  },
  "OFFICE_CODE_B": {
    "clientId": "...",
    "clientSecret": "...",
    "refreshToken": "..."
  }
}
```

The file should be `chmod 600` — it contains long-lived refresh tokens. `npm run authorize` sets this automatically when it writes the file.

### Path resolution (first match wins)

| Priority | Path |
|----------|------|
| 1 | `TWINFIELD_CREDENTIALS_FILE` environment variable (explicit path) |
| 2 | `~/.twinfield/credentials.json` (default user-level location) |
| 3 | `./credentials.json` (local fallback for development) |

### Reloading credentials at runtime

When a new office entry is added externally — e.g. by running `npm run authorize` from a sibling tool — the file change is not yet visible to a running MCP server. The **`reload_credentials`** tool re-reads the JSON file from disk and replaces the in-memory map in place. Tokens for offices that **changed** or were **removed** are evicted from the token cache automatically; tokens for unchanged offices stay warm so subsequent calls do not pay the refresh cost.

---

## Available tools (11)

### Authentication & setup

| Tool | Description |
|------|-------------|
| `whoami` | Validate Twinfield authentication for an office. Calls the OpenID Connect userinfo endpoint and returns the organisation claims. Run this first to confirm credentials, cluster discovery, and the refresh-token flow all work end-to-end. |
| `reload_credentials` | Re-read the office → credentials JSON file from disk without restarting the server. Returns a diff of added/updated/removed office codes and invalidates affected tokens. |

### Offices

| Tool | Description |
|------|-------------|
| `list_offices` | List all Twinfield offices (CompanyCodes) accessible with the current OAuth credentials. **Run this after `whoami`** to discover which office codes can be passed as the `office` parameter to other tools. |

### Dimensions (master data)

Twinfield models customers, suppliers, GL accounts, cost centres, and projects as "dimensions" with a 3-letter type code. Each tool below is a thin wrapper over `<list><type>dimensions</type><dimtype>…</dimtype></list>` with a fixed dimtype.

| Tool | Dimtype | Description |
|------|---------|-------------|
| `get_customers` | DEB | List all customers (debtors) for an office. |
| `get_suppliers` | CRD | List all suppliers / vendors (creditors) for an office. |
| `get_gl_accounts` | BAS | List all GL accounts (balance sheet) for an office. |
| `get_cost_centers` | KPL | List all cost centres for an office. |
| `get_projects` | PRJ | List all projects for an office. |

All dimension tools return an array of `{ code, name?, shortname? }` entries.

### Transactions (browse queries)

Built on Twinfield's `<columns code="100">` browse query. Each row in the response is one transaction *line* with daybook, number, date, year-period, counterparty (`fin.trs.line.dim2`), match status, signed amount, and signed open amount.

| Tool | Default daybook | Description |
|------|-----------------|-------------|
| `get_transactions` | — | List transactions filtered by daybook code, year-period range, and/or counterparty. Run without filters to discover the daybook codes used on this office. |
| `get_sales_invoices` | `VRK` | Sales invoice lines. Pass `openOnly=true` to keep only unpaid lines. |
| `get_purchase_invoices` | `INK` | Purchase invoice lines. Pass `openOnly=true` to keep only unpaid lines. |

**Common parameters** for all three:

- `office?: string` — override the default office.
- `daybook?: string` — Twinfield daybook code (`VRK`, `INK`, `BNK`, `KAS`, `MEMO`, …). Overrides the per-tool default.
- `yearperiodFrom?: string`, `yearperiodTo?: string` — inclusive range in `YYYY/PP` format (e.g. `2024/01` to `2024/12`). Must be supplied together.
- `counterparty?: string` — filter to a single customer/supplier code.
- `openOnly?: boolean` — client-side post-filter that keeps only rows whose match status is `available` (only on `get_sales_invoices` / `get_purchase_invoices`).

> **Note on daybook codes.** `VRK` and `INK` are the Dutch defaults (Verkoop / Inkoop). Offices on a non-Dutch Twinfield template may use different codes — run `get_transactions` once without filters and inspect the `daybook` field on the result to see what your office uses.

---

## Testing

### MCP Inspector (tool-level, no LLM)

```bash
npm run inspect
```

Opens a browser UI where you can call individual tools and inspect raw responses.

### Standalone probes

For quick command-line validation without the MCP layer:

```bash
npx tsx scripts/whoami.ts            # exercises refresh + cluster + userinfo
npx tsx scripts/list-offices.ts      # exercises the ProcessXml SOAP path
```

---

## Architecture

```
src/
├── index.ts                  # Entry point — loads env + credentials, registers tools, starts stdio transport
├── twinfield-client.ts       # OAuth2 token cache, cluster discovery, SOAP envelope, ProcessXml call, fair-use handling
└── tools/
    ├── auth.ts               # whoami, reload_credentials
    ├── offices.ts            # list_offices
    ├── dimensions.ts         # get_customers, get_suppliers, get_gl_accounts,
    │                         # get_cost_centers, get_projects
    └── transactions.ts       # get_transactions, get_sales_invoices,
                              # get_purchase_invoices

scripts/
├── authorize.ts              # One-time interactive OAuth2 authorization-code flow
├── whoami.ts                 # Standalone auth-chain probe
└── list-offices.ts           # Standalone ProcessXml probe
```

### Auth flow

Twinfield uses OpenID Connect (authorization code + refresh token). The server-side flow:

1. `npm run authorize` runs the **authorization code** grant once per office, captures the refresh token, and writes it to `~/.twinfield/credentials.json`.
2. At runtime, `TwinfieldClient.getAccessToken(office)` exchanges the refresh token for a fresh access token (1-hour TTL) and caches it. The cache is refreshed ~30 seconds before expiry to absorb clock skew.
3. The cluster URL (`https://api.<cluster>.twinfield.com`) is discovered by calling Twinfield's `accesstokenvalidation` endpoint, which returns the `twf.clusterUrl` claim. It's cached alongside the access token.
4. Every business call goes to `{cluster}/webservices/processxml.asmx` with a SOAP header containing `AccessToken` + `CompanyCode` + `CompanyId xsi:nil="true"`.

### ProcessXml envelope

Twinfield's `ProcessXmlString` method takes a single `xs:string` parameter. The Twinfield XML payload (`<list>`, `<read>`, `<columns>`, etc.) must therefore be **escaped** as character data inside `<xmlRequest>`. The response is similarly a string containing escaped XML — the client re-parses it so tools see a structured object.

The SOAP header is the OAuth2 variant of Twinfield's legacy session-based header:

```xml
<soap:Header>
  <Header xmlns="http://www.twinfield.com/">
    <AccessToken>...</AccessToken>
    <CompanyCode>YOUR-OFFICE-CODE</CompanyCode>
    <CompanyId xsi:nil="true" />
  </Header>
</soap:Header>
```

`CompanyId` is `minOccurs="1"` in the WSDL but `nillable="true"` — leaving it out causes a generic HTTP 400 with no SOAP fault body.

---

## Rate limits

Twinfield enforces a credit-based fair-use policy (HTTP 429 with `Retry-After` when exceeded):

| Bucket | Certified clients | Uncertified clients |
|---|---|---|
| Per ClientId | 1000 credits/min | **50 credits/min** |
| Per ClientId + Organisation | 500 credits/min | **25 credits/min** |
| Per IP | 1000 credits/min | 1000 credits/min |

Query requests (read tools) cost 1 credit; mutations cost 3. Concurrency is capped at 20 in-flight requests per ClientId / 10 per Organisation. Transactions are hard-capped at 1000 lines (HTTP 400 if exceeded).

A fresh OAuth client is **uncertified** by default. The 50/min budget is enough for interactive agent usage but you'll want to design batch workflows to fetch broad lists once rather than re-fetching on every step. `TwinfieldClient` honours `Retry-After` with one bounded retry on 429.

---

## Troubleshooting

| Error | Likely cause |
|-------|-------------|
| `Twinfield OAuth error during refresh token exchange — invalid_grant` | Refresh token was invalidated — re-run `npm run authorize` for the affected office. |
| `Twinfield token-validation response did not include a usable twf.clusterUrl claim` | Access token is missing the `twf.organisation` scope — re-authorize. |
| `No Twinfield credentials configured for office "..."` | The office code isn't in `~/.twinfield/credentials.json` — run `npm run authorize` for it, then call `reload_credentials`. |
| `HTTP 400 Bad Request from .../processxml.asmx` (no body) | The SOAP envelope is malformed in a way that fails Twinfield's WCF deserializer before any handler runs. Usually a header field missing or an unescaped `<xmlRequest>`. |
| `SOAP Fault: An error occurred on the server.` (with reference code) | Twinfield server-side error — note the reference code (`YYYY-MM-DD CXXXXXX`) and contact Twinfield support. Often caused by a malformed `<columns>` browse payload. |
| `Type niet geïmplementeerd.` | The `<list>` or `<read>` type you requested isn't supported on the ProcessXml endpoint. Many entities are only exposed via other SOAP services (Finder, BankBook, Documents) — not yet wrapped by this MCP. |
| HTTP 429 with `Retry-After` | Fair-use credit budget exceeded — the client retries once automatically, then surfaces the error. Reduce request rate or apply for client certification. |

---

## About CodeMill Solutions

[CodeMill Solutions](https://codemill.dev/en/) is a Dutch software company based in the Netherlands. We build smart, scalable, and customized solutions that help organizations grow, optimize processes, and realize their digital ambitions.

Our services include:

- **Custom applications** — portals, dashboards, business software, and fully tailored platforms that truly add value.
- **API integrations** — connecting your application with other systems and external platforms via smart API connections.
- **Mobile apps** — iOS and Android apps as a logical extension of your web application(s).

`twinfield-mcp` is one of our open-source integrations, making Twinfield's accounting platform accessible to AI agents through the Model Context Protocol.

📧 [info@codemill.dev](mailto:info@codemill.dev)
🌐 [codemill.dev](https://codemill.dev/en/)
💼 [LinkedIn](https://www.linkedin.com/company/codemill-solutions/)
🐙 [GitHub](https://github.com/CodeMill-Solutions)

---

## License

MIT — see [LICENSE](./LICENSE).
