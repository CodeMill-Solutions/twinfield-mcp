import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TwinfieldClient, loadCredentialsFile, type TwinfieldOfficeCredentials } from './twinfield-client.js';
import { registerAuthTools } from './tools/auth.js';
import { registerOfficeTools } from './tools/offices.js';
import { registerDimensionTools } from './tools/dimensions.js';
import { registerTransactionTools } from './tools/transactions.js';

// ── Credentials map ───────────────────────────────────────────────────────────
//
// Optionally load a JSON file that maps officeCode → OAuth2 credentials.
// This allows the MCP server to serve multiple Twinfield offices, each with
// its own client_id / client_secret / refresh_token, without requiring a
// single set of credentials in the environment.
//
// The file format is a plain JSON object:
//   {
//     "<officeCode>": {
//       "clientId": "...",
//       "clientSecret": "...",
//       "refreshToken": "..."
//     },
//     ...
//   }
//
// Path resolution + parsing lives in `twinfield-client.ts`
// (`loadCredentialsFile`) so the runtime reload tool (Phase 1) can share the
// exact same behaviour.

let credentialsMap = new Map<string, TwinfieldOfficeCredentials>();
let credentialsFilePath = '(none)';

try {
  const loaded = loadCredentialsFile();
  credentialsFilePath = loaded.path;
  credentialsMap = loaded.map;
  if (loaded.found) {
    process.stderr.write(
      `[twinfield-mcp] Loaded credentials for ${credentialsMap.size} office(s) from ${credentialsFilePath}\n`,
    );
  }
} catch (err) {
  process.stderr.write(
    `[twinfield-mcp] Warning: could not read credentials file at ${credentialsFilePath}: ${err}\n`,
  );
}

// ── Environment validation ────────────────────────────────────────────────────

const defaultOffice = process.env['TWINFIELD_OFFICE_CODE'] ?? '';
const envClientId = process.env['TWINFIELD_CLIENT_ID'] ?? '';
const envClientSecret = process.env['TWINFIELD_CLIENT_SECRET'] ?? '';
const envRefreshToken = process.env['TWINFIELD_REFRESH_TOKEN'] ?? '';

// If a single-office set of env vars is provided and that office is not
// already in the file-based map, treat the env vars as the default office's
// credentials. This is the local-dev fallback called out in the plan.
if (defaultOffice && envClientId && envClientSecret && envRefreshToken && !credentialsMap.has(defaultOffice)) {
  credentialsMap.set(defaultOffice, {
    clientId: envClientId,
    clientSecret: envClientSecret,
    refreshToken: envRefreshToken,
  });
}

if (credentialsMap.size === 0) {
  process.stderr.write(
    '[twinfield-mcp] Warning: no Twinfield credentials configured.\n' +
      '           Run `npm run authorize` (Phase 1) or fill in TWINFIELD_* env vars,\n' +
      '           or place a credentials.json at ~/.twinfield/credentials.json.\n',
  );
}

// ── Twinfield SOAP client ─────────────────────────────────────────────────────

const twinfieldClient = new TwinfieldClient(defaultOffice, credentialsMap);

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'twinfield-mcp',
  version: '0.3.0',
});

registerAuthTools(server, twinfieldClient);
registerOfficeTools(server, twinfieldClient);
registerDimensionTools(server, twinfieldClient);
registerTransactionTools(server, twinfieldClient);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

await server.connect(transport);

const credInfo =
  credentialsMap.size > 0
    ? `${credentialsMap.size} office credential set(s) loaded`
    : 'no credentials configured';

process.stderr.write(
  `[twinfield-mcp] Server started — 15 tools registered ` +
    `(whoami, reload_credentials, list_offices, get_office, get_customers, get_suppliers, ` +
    `get_gl_accounts, get_cost_centers, get_projects, get_transactions, get_sales_invoices, ` +
    `get_purchase_invoices, upsert_customer, upsert_supplier, process_journal). ` +
    `Default office: ${defaultOffice || '(none)'} — ${credInfo}\n`,
);
