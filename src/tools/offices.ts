import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwinfieldClient, escapeXml } from '../twinfield-client.js';

/**
 * Register office-related tools.
 *
 * Twinfield's data model has two levels:
 *   - **Organisation** — the whole tenant, tied to one OAuth client.
 *   - **Office** (a.k.a. CompanyCode) — a specific administration inside it.
 *
 * One refresh token typically grants access to multiple offices within the
 * same organisation. `list_offices` is the canonical "what can I see?" call,
 * and it doubles as a structural smoke test for the SOAP envelope: a working
 * response proves the namespace, header layout, and ProcessXml signature
 * assumptions are all correct.
 */
export function registerOfficeTools(server: McpServer, client: TwinfieldClient): void {
  registerGetOfficeTool(server, client);

  server.registerTool(
    'list_offices',
    {
      description:
        'List all Twinfield offices (CompanyCodes) accessible with the current OAuth ' +
        'credentials. Run this after `whoami` to discover which office codes can be passed ' +
        'as the `office` parameter to other tools. Calls ProcessXml with `<list><type>offices</type></list>`.',
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe(
            'Office code to use as the SOAP CompanyCode header for this call. ' +
              'Any office on the account works — defaults to TWINFIELD_OFFICE_CODE.',
          ),
      },
    },
    async ({ office }) => {
      try {
        const result = await client.callProcessXml({
          office,
          xmlBody: '<list><type>offices</type></list>',
        });

        const offices = normalizeOffices(result);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, count: offices.length, offices }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the `get_office` tool.
 *
 * Twinfield's `<read><type>office>` requires BOTH `<office>` (context) and
 * `<code>` (identifier), even when they refer to the same office. Without
 * the `<code>` element Twinfield returns the unhelpful
 * "U hebt geen toegang tot deze administratie." error.
 *
 * Surfaces a curated top-level slice (code, name, currencies, VAT/CoC
 * numbers, address, etc.) plus the full raw response under `details` for
 * agents that need more.
 */
function registerGetOfficeTool(server: McpServer, client: TwinfieldClient): void {
  server.registerTool(
    'get_office',
    {
      description:
        'Read full details for a single Twinfield office (CompanyCode): base currency, ' +
        'VAT and CoC numbers, default bank, region, address, fiscal year, and more. ' +
        'For just a list of office codes use `list_offices`.',
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe('Office code to look up. Defaults to TWINFIELD_OFFICE_CODE.'),
      },
    },
    async ({ office }) => {
      try {
        const resolvedOffice = office ?? client.defaultOfficeCode;
        if (!resolvedOffice) {
          throw new Error('No office code provided and TWINFIELD_OFFICE_CODE is not set.');
        }
        const result = await client.callProcessXml({
          office: resolvedOffice,
          xmlBody: `<read><type>office</type><office>${escapeXml(resolvedOffice)}</office><code>${escapeXml(resolvedOffice)}</code></read>`,
        });

        const summary = summarizeOffice(result);
        if (!summary) {
          throw new Error(`Twinfield returned an unexpected shape for office "${resolvedOffice}".`);
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, office: summary, details: result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}

/** Extract a flat summary from the parsed `<read type="office">` response. */
function summarizeOffice(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as Record<string, unknown>;
  const officeRaw = rec['office'];
  const office = (Array.isArray(officeRaw) ? officeRaw[0] : officeRaw) as Record<string, unknown> | undefined;
  if (!office) return null;

  const general = office['general'] as Record<string, unknown> | undefined;
  const address = (general?.['address'] ?? {}) as Record<string, unknown>;

  return {
    code: text(office['code']),
    name: text(office['name']),
    shortname: text(office['shortname']) || undefined,
    baseCurrency: text(general?.['basecurrency']),
    reportingCurrency: text(general?.['reportingcurrency']),
    type: text(general?.['type']),
    demo: general?.['demo'] === true || general?.['demo'] === 'true',
    vatNumber: text(general?.['vatnumber']) || undefined,
    cocNumber: text(general?.['cocnumber']) || undefined,
    defaultBank: text(general?.['defaultbank']) || undefined,
    region: text(general?.['region']) || undefined,
    hierarchy: text(general?.['hierarchy']) || undefined,
    address: {
      city: text(address['city']) || undefined,
      country: text(address['country']) || undefined,
    },
    created: text(office['created']) || undefined,
    modified: text(office['modified']) || undefined,
  };
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && '#text' in v) {
    const t = (v as Record<string, unknown>)['#text'];
    if (typeof t === 'string' || typeof t === 'number') return String(t);
  }
  return '';
}

/**
 * Normalise the parsed `<offices result="1"><office name="..." shortname="...">CODE</office>...</offices>`
 * response into a flat `[{ code, name, shortname }]` array.
 *
 * Twinfield wraps list-query responses in a plural root element matching the
 * `<type>` value — `<list><type>offices</type></list>` → `<offices>...</offices>`.
 * On an error response (`result="0"`) the function throws so the tool surfaces
 * the message to the caller instead of returning a misleading empty list.
 */
function normalizeOffices(result: unknown): Array<{ code: string; name?: string; shortname?: string }> {
  if (!result || typeof result !== 'object') return [];
  const root = ((result as Record<string, unknown>)['offices'] ?? result) as Record<string, unknown>;

  const resultAttr = root['@_result'];
  if (resultAttr !== undefined && resultAttr !== 1 && resultAttr !== '1') {
    const msg = root['msg'];
    throw new Error(
      `Twinfield offices list call failed (result=${String(resultAttr)})${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}`,
    );
  }

  const offices = root['office'];
  if (offices === undefined) return [];
  const arr = Array.isArray(offices) ? offices : [offices];

  return arr.map((entry) => {
    if (typeof entry === 'string') return { code: entry };
    const obj = entry as Record<string, unknown>;
    const code = (obj['#text'] as string | undefined) ?? (obj['code'] as string | undefined) ?? '';
    const nameRaw = obj['@_name'] ?? obj['name'];
    const shortRaw = obj['@_shortname'] ?? obj['shortname'];
    const name = typeof nameRaw === 'string' ? nameRaw : undefined;
    const shortname = typeof shortRaw === 'string' && shortRaw.length > 0 ? shortRaw : undefined;
    return { code: String(code), name, shortname };
  });
}
