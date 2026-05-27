#!/usr/bin/env tsx
/**
 * Standalone whoami probe — exercises the full OAuth2 → cluster → userinfo
 * chain without going through the MCP transport. Handy as the Phase-1
 * go/no-go gate before wiring up business tools.
 *
 * Usage:
 *   npx tsx scripts/whoami.ts [officeCode]
 */
import 'dotenv/config';
import { TwinfieldClient, loadCredentialsFile } from '../src/twinfield-client.js';

async function main(): Promise<void> {
  const loaded = loadCredentialsFile();
  if (!loaded.found) {
    console.error(`No credentials file found (looked at ${loaded.path}). Run \`npm run authorize\` first.`);
    process.exit(1);
  }

  const officeArg = process.argv[2];
  const defaultOffice = officeArg ?? process.env['TWINFIELD_OFFICE_CODE'] ?? loaded.map.keys().next().value ?? '';
  if (!defaultOffice) {
    console.error('No office code available. Pass one as the first argument or set TWINFIELD_OFFICE_CODE.');
    process.exit(1);
  }

  console.log(`Probing Twinfield auth for office "${defaultOffice}" (credentials: ${loaded.path})\n`);
  const client = new TwinfieldClient(defaultOffice, loaded.map);

  const token = await client.getAccessToken();
  console.log('Access token acquired.');
  console.log(`  Expires at:  ${new Date(token.expiresAt).toISOString()}`);
  console.log(`  Cluster URL: ${token.clusterUrl}\n`);

  const claims = await client.fetchUserInfo();
  console.log('Userinfo claims:');
  console.log(JSON.stringify(claims, null, 2));
}

main().catch((err) => {
  console.error('\nwhoami probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
