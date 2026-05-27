#!/usr/bin/env tsx
/**
 * One-time interactive Twinfield OAuth2 authorization flow.
 *
 * What this script does:
 *   1. Asks for client_id / client_secret / office code (via env or prompt).
 *   2. Spins up a localhost HTTP server on a free port.
 *   3. Opens the Twinfield authorize URL in your default browser.
 *   4. Receives the `code` on the localhost callback.
 *   5. Exchanges the code for an access + refresh token at the token endpoint.
 *   6. Calls the access-token-validation endpoint to discover the cluster URL.
 *   7. Writes/updates `~/.twinfield/credentials.json` with the office entry.
 *
 * After this script finishes, the MCP server (and any tool such as `whoami`)
 * can authenticate non-interactively using the saved refresh token. The
 * refresh token has a 25-year TTL per Twinfield's OpenID Connect docs.
 *
 * Usage:
 *   npx tsx scripts/authorize.ts
 *
 * Optional env vars (skip prompts):
 *   TWINFIELD_CLIENT_ID, TWINFIELD_CLIENT_SECRET, TWINFIELD_OFFICE_CODE,
 *   TWINFIELD_AUTHORIZE_PORT (defaults to 8765 — must match the redirect URL
 *                              you registered in the Twinfield Developer Portal).
 */
import 'dotenv/config';
import axios from 'axios';
import { exec } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import {
  TWINFIELD_AUTHORIZE_URL,
  TWINFIELD_TOKEN_URL,
  TWINFIELD_DEFAULT_SCOPES,
  resolveCredentialsFilePath,
  type TwinfieldOfficeCredentials,
  TwinfieldClient,
} from '../src/twinfield-client.js';

async function prompt(question: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer;
  } finally {
    rl.close();
  }
}

async function promptSecret(question: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  // Best-effort masking; readline doesn't natively support it.
  process.stdout.write(question);
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdout.write('\n');
          stdin.off('data', onData);
          stdin.pause();
          resolve(buf.trim());
          return;
        }
        if (ch === '') {
          // Ctrl-C
          process.exit(130);
        }
        if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.setEncoding('utf-8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Ignore errors — the URL is also printed for manual fallback.
  });
}

interface CallbackResult {
  code: string;
  state: string;
}

function waitForCallback(server: Server, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      if (!req.url) return;
      const requested = new URL(req.url, 'http://localhost');
      if (requested.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const code = requested.searchParams.get('code');
      const state = requested.searchParams.get('state');
      const error = requested.searchParams.get('error');

      if (error) {
        res.statusCode = 400;
        res.end(`Authorization failed: ${error}`);
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (!code || !state) {
        res.statusCode = 400;
        res.end('Missing code or state parameter.');
        reject(new Error('Twinfield callback missing code or state.'));
        return;
      }
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end('State mismatch — possible CSRF.');
        reject(new Error('State mismatch in Twinfield callback.'));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h2>Twinfield authorization complete.</h2><p>You can close this tab and return to the terminal.</p>');
      resolve({ code, state });
    });
  });
}

function loadExistingCredentials(path: string): Record<string, TwinfieldOfficeCredentials> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, TwinfieldOfficeCredentials>;
  } catch (err) {
    throw new Error(`Could not parse existing credentials file at ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  console.log('Twinfield interactive authorization — Phase 1\n');

  const clientId = await prompt('client_id: ', process.env['TWINFIELD_CLIENT_ID']);
  const clientSecret = await promptSecret('client_secret: ', process.env['TWINFIELD_CLIENT_SECRET']);
  const office = await prompt('office code to associate (CompanyCode): ', process.env['TWINFIELD_OFFICE_CODE']);

  if (!clientId || !clientSecret || !office) {
    console.error('client_id, client_secret and office code are all required.');
    process.exit(1);
  }

  // Fixed default port so it matches the redirect URL registered in the
  // Twinfield Developer Portal. Override with TWINFIELD_AUTHORIZE_PORT if you
  // registered a different one.
  const port = Number(process.env['TWINFIELD_AUTHORIZE_PORT'] ?? 8765);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not determine local callback port.');
  }
  const redirectUri = `http://localhost:${address.port}/callback`;

  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const authorizeUrl = new URL(TWINFIELD_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', TWINFIELD_DEFAULT_SCOPES);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);

  console.log('\nOpen the following URL in your browser (it should open automatically):');
  console.log(authorizeUrl.toString());
  openInBrowser(authorizeUrl.toString());

  let callback: CallbackResult;
  try {
    callback = await waitForCallback(server, state);
  } finally {
    server.close();
  }

  // Exchange the authorization code for tokens.
  console.log('\nExchanging authorization code for tokens…');
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResponse = await axios.post<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  }>(
    TWINFIELD_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirectUri,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
      timeout: 30_000,
    },
  );

  const { access_token, refresh_token } = tokenResponse.data;
  if (!refresh_token) {
    throw new Error(
      'Twinfield did not return a refresh_token. Verify that the client is configured with the `offline_access` scope.',
    );
  }

  // Resolve cluster URL via the access-token-validation endpoint so we can
  // print it back for the user. The MCP server resolves it lazily on every
  // refresh, but echoing it here is useful sanity-check feedback.
  const probeClient = new TwinfieldClient(office, new Map());
  let clusterUrl = '(not resolved)';
  try {
    clusterUrl = await probeClient.resolveClusterUrl(access_token);
  } catch (err) {
    console.warn(`\nWarning: cluster URL probe failed — ${err instanceof Error ? err.message : err}`);
  }

  // Write to ~/.twinfield/credentials.json (or wherever the standard
  // precedence resolves to).
  const credentialsPath = resolveCredentialsFilePath();
  mkdirSync(dirname(credentialsPath), { recursive: true });
  const existing = loadExistingCredentials(credentialsPath);
  existing[office] = { clientId, clientSecret, refreshToken: refresh_token };
  writeFileSync(credentialsPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

  console.log('\nAuthorization complete.');
  console.log(`  Office:          ${office}`);
  console.log(`  Cluster URL:     ${clusterUrl}`);
  console.log(`  Credentials at:  ${credentialsPath}`);
  console.log('\nYou can now run `npm run dev` (or `npm run inspect`) and call the `whoami` tool to verify.');
}

main().catch((err) => {
  console.error('\nAuthorization failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
