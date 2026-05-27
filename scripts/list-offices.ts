#!/usr/bin/env tsx
/**
 * Standalone list_offices probe — calls ProcessXml with the offices-list
 * payload and prints the result. Validates the SOAP envelope, header, and
 * namespace assumptions in one shot.
 *
 * Usage:
 *   npx tsx scripts/list-offices.ts [officeCode]
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

  console.log(`Listing offices via office "${defaultOffice}" (credentials: ${loaded.path})\n`);
  const client = new TwinfieldClient(defaultOffice, loaded.map);

  const raw = await client.callProcessXml({
    xmlBody: '<list><type>offices</type></list>',
  });
  console.log('Raw ProcessXml result:');
  console.log(JSON.stringify(raw, null, 2));
}

main().catch((err) => {
  console.error('\nlist-offices probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
