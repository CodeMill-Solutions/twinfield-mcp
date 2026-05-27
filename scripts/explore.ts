#!/usr/bin/env tsx
/**
 * Exploration probe — fires one or more ProcessXml requests and prints the
 * raw, parsed response. Intended for debugging XML payload shapes against a
 * live account; not part of the production code path.
 *
 * Usage:
 *   npx tsx scripts/explore.ts <kind> [office]
 *
 * Kinds:
 *   debtors      — list dimensions of type DEB (customers)
 *   creditors    — list dimensions of type CRD (suppliers)
 *   gl           — list dimensions of type BAS (GL accounts)
 *   office       — read the current office record
 */
import 'dotenv/config';
import { TwinfieldClient, loadCredentialsFile } from '../src/twinfield-client.js';

const PAYLOADS: Record<string, (office: string) => string> = {
  debtors: (office) => `<list><type>dimensions</type><office>${office}</office><dimtype>DEB</dimtype></list>`,
  creditors: (office) => `<list><type>dimensions</type><office>${office}</office><dimtype>CRD</dimtype></list>`,
  gl: (office) => `<list><type>dimensions</type><office>${office}</office><dimtype>BAS</dimtype></list>`,
  office: (office) => `<read><type>office</type><office>${office}</office></read>`,
  // ── Transaction discovery ──
  daybooks: (office) => `<list><type>daybooks</type><office>${office}</office></list>`,
  transactions: (office) => `<list><type>transactions</type><office>${office}</office><code>030</code></list>`,
  // ── Browse-style query ──
  browse030: (office) =>
    `<columns code="030"><column id="fin.trs.head.code"><field>fin.trs.head.code</field><visible>true</visible></column><column id="fin.trs.head.number"><field>fin.trs.head.number</field><visible>true</visible></column><column id="fin.trs.head.date"><field>fin.trs.head.date</field><visible>true</visible></column></columns>`,
  // ── Period / balance reads ──
  periods: (office) => `<read><type>periods</type><office>${office}</office></read>`,
  // ── Other list types worth checking ──
  vatcodes: (office) => `<list><type>vatcodes</type><office>${office}</office></list>`,
  currencies: (office) => `<list><type>currencies</type><office>${office}</office></list>`,
  dimtypes: (office) => `<list><type>dimtypes</type><office>${office}</office></list>`,
  costcenters: (office) => `<list><type>dimensions</type><office>${office}</office><dimtype>KPL</dimtype></list>`,
  projects: (office) => `<list><type>dimensions</type><office>${office}</office><dimtype>PRJ</dimtype></list>`,
  // ── Office details via `read` ──
  currentcompany: (office) => `<read><type>currentcompany</type><office>${office}</office></read>`,
};

async function main(): Promise<void> {
  const kind = process.argv[2];
  if (!kind || !PAYLOADS[kind]) {
    console.error(`Usage: npx tsx scripts/explore.ts <${Object.keys(PAYLOADS).join('|')}> [office]`);
    process.exit(1);
  }

  const loaded = loadCredentialsFile();
  if (!loaded.found) throw new Error(`No credentials at ${loaded.path}`);
  const office =
    process.argv[3] ?? process.env['TWINFIELD_OFFICE_CODE'] ?? loaded.map.keys().next().value!;
  const client = new TwinfieldClient(office, loaded.map);

  const xml = PAYLOADS[kind](office);
  console.log(`Sending payload for "${kind}" against office "${office}":\n  ${xml}\n`);
  const raw = await client.callProcessXml({ xmlBody: xml });
  console.log('Parsed response:');
  console.log(JSON.stringify(raw, null, 2).slice(0, 4000));
}

main().catch((err) => {
  console.error('\nexplore probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
