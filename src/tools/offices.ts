import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwinfieldClient } from '../twinfield-client.js';

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
