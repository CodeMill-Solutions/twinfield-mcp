import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwinfieldClient, escapeXml } from '../twinfield-client.js';

/**
 * Register dimension-read tools.
 *
 * Twinfield models customers, suppliers, GL accounts, cost centres and
 * projects all as "dimensions" with a type code:
 *   - DEB → debtor       (customer)
 *   - CRD → creditor     (supplier)
 *   - BAS → balance      (GL account)
 *   - KPL → cost centre
 *   - PRJ → project
 *
 * The list query is the same in all cases:
 *   <list>
 *     <type>dimensions</type>
 *     <office>YOUR-OFFICE-CODE</office>
 *     <dimtype>DEB</dimtype>
 *   </list>
 *
 * Twinfield responds with `<dimensions result="1"><dimension name="..."
 * shortname="...">CODE</dimension>...</dimensions>`. We expose three
 * convenience tools — `get_customers`, `get_suppliers`, `get_gl_accounts` —
 * that wrap this with a fixed dimtype so agents don't need to know the
 * three-letter codes.
 */
export function registerDimensionTools(server: McpServer, client: TwinfieldClient): void {
  registerDimensionListTool(server, client, {
    name: 'get_customers',
    dimtype: 'DEB',
    description:
      'List all customers (Twinfield dimensions of type DEB) for an office. ' +
      'Returns an array of `{ code, name, shortname? }` entries. ' +
      'Use this to discover customer codes for use in invoice or transaction tools.',
  });

  registerDimensionListTool(server, client, {
    name: 'get_suppliers',
    dimtype: 'CRD',
    description:
      'List all suppliers / vendors (Twinfield dimensions of type CRD) for an office. ' +
      'Returns an array of `{ code, name, shortname? }` entries.',
  });

  registerDimensionListTool(server, client, {
    name: 'get_gl_accounts',
    dimtype: 'BAS',
    description:
      'List all general ledger accounts (Twinfield dimensions of type BAS) for an office. ' +
      'Returns an array of `{ code, name, shortname? }` entries — useful for resolving ' +
      'GL codes when reading or writing journal entries.',
  });

  registerDimensionListTool(server, client, {
    name: 'get_cost_centers',
    dimtype: 'KPL',
    description:
      'List all cost centres (Twinfield dimensions of type KPL) for an office. ' +
      'Returns an array of `{ code, name, shortname? }` entries.',
  });

  registerDimensionListTool(server, client, {
    name: 'get_projects',
    dimtype: 'PRJ',
    description:
      'List all projects (Twinfield dimensions of type PRJ) for an office. ' +
      'Returns an array of `{ code, name, shortname? }` entries.',
  });

  registerDimensionUpsertTool(server, client, {
    name: 'upsert_customer',
    dimtype: 'DEB',
    label: 'customer',
    description:
      'Create or update a customer (Twinfield dimension of type DEB). When `code` matches ' +
      'an existing customer the record is updated; otherwise a new one is created. The ' +
      'allowed code format depends on the office configuration — Dutch templates typically ' +
      'use 4-digit codes in the 1000–1999 range. Returns the office, code, and final name.',
  });

  registerDimensionUpsertTool(server, client, {
    name: 'upsert_supplier',
    dimtype: 'CRD',
    label: 'supplier',
    description:
      'Create or update a supplier (Twinfield dimension of type CRD). When `code` matches ' +
      'an existing supplier the record is updated; otherwise a new one is created. The ' +
      'allowed code format depends on the office configuration — Dutch templates typically ' +
      'use 4-digit codes in the 2000–2999 range.',
  });
}

interface DimensionToolSpec {
  name: string;
  dimtype: string;
  description: string;
}

function registerDimensionListTool(server: McpServer, client: TwinfieldClient, spec: DimensionToolSpec): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe(
            'Twinfield office code (CompanyCode). Defaults to TWINFIELD_OFFICE_CODE when omitted.',
          ),
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
          xmlBody: `<list><type>dimensions</type><office>${resolvedOffice}</office><dimtype>${spec.dimtype}</dimtype></list>`,
        });

        const dimensions = normalizeDimensions(result, spec.dimtype);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, office: resolvedOffice, dimtype: spec.dimtype, count: dimensions.length, dimensions },
                null,
                2,
              ),
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
 * Normalise a `<dimensions result="1"><dimension name="..." shortname="...">CODE</dimension>...</dimensions>`
 * response into a flat `[{ code, name?, shortname? }]` array.
 *
 * Twinfield appends a marker entry at the end of every dimensions list whose
 * `#text` equals the requested dimtype (e.g. `DEB`, `CRD`, `BAS`) and whose
 * name is empty. We drop that entry when `dimtype` is supplied — it's a
 * type-tag, not a real dimension. Without `dimtype` the marker is kept so
 * callers can do their own filtering if they need to.
 *
 * Twinfield returns `result="0"` plus a `msg` attribute on errors — we
 * surface those as thrown Errors so the tool wrapper can report them,
 * rather than silently returning an empty list.
 */
export function normalizeDimensions(
  result: unknown,
  dimtype?: string,
): Array<{ code: string; name?: string; shortname?: string }> {
  if (!result || typeof result !== 'object') return [];
  const root = ((result as Record<string, unknown>)['dimensions'] ?? result) as Record<string, unknown>;

  const resultAttr = root['@_result'];
  if (resultAttr !== undefined && resultAttr !== 1 && resultAttr !== '1') {
    const msg = root['@_msg'] ?? root['msg'];
    throw new Error(
      `Twinfield dimensions list call failed (result=${String(resultAttr)})${msg ? `: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` : ''}`,
    );
  }

  const items = root['dimension'];
  if (items === undefined) return [];
  const arr = Array.isArray(items) ? items : [items];

  return arr
    .map((entry) => {
      if (typeof entry === 'string' || typeof entry === 'number') return { code: String(entry) };
      const obj = entry as Record<string, unknown>;
      const code = (obj['#text'] as string | number | undefined) ?? (obj['code'] as string | undefined) ?? '';
      const nameRaw = obj['@_name'] ?? obj['name'];
      const shortRaw = obj['@_shortname'] ?? obj['shortname'];
      const name = typeof nameRaw === 'string' ? nameRaw : undefined;
      const shortname = typeof shortRaw === 'string' && shortRaw.length > 0 ? shortRaw : undefined;
      return { code: String(code), name, shortname };
    })
    .filter((d) => {
      if (!dimtype) return true;
      // Drop Twinfield's trailing type-marker row: code === dimtype + empty name.
      return !(d.code === dimtype && (d.name === undefined || d.name === ''));
    });
}

// ── Dimension upsert (writes) ────────────────────────────────────────────────

interface DimensionUpsertSpec {
  name: string;
  dimtype: string;
  /** Human-readable noun used in tool descriptions, e.g. "customer". */
  label: string;
  description: string;
}

/**
 * Register an `upsert_<noun>` write tool for a dimension type.
 *
 * Twinfield's `<dimensions><dimension>` write is idempotent on `<code>`: if
 * the code already exists the record is updated, otherwise a new one is
 * created. Codes are validated against the office's configured pattern
 * (e.g. `1[0-9][0-9][0-9]` for DEB on Dutch templates) — Twinfield returns
 * a structured error if the format is wrong.
 *
 * `<inuse>` is explicitly NOT accepted as an input element (Twinfield
 * rejects it with "Het element 'inuse' mag niet worden aangeleverd"). The
 * active/inactive state is managed via a separate operation not exposed
 * here.
 */
function registerDimensionUpsertTool(
  server: McpServer,
  client: TwinfieldClient,
  spec: DimensionUpsertSpec,
): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe(
            `Twinfield dimension code for the ${spec.label}. Must match the office's ` +
              `configured code pattern. Numeric codes will be sent verbatim; the office ` +
              `pattern usually enforces a width (e.g. 4 digits for ${spec.dimtype}).`,
          ),
        name: z.string().min(1).describe(`Display name of the ${spec.label}.`),
        shortname: z.string().optional().describe('Optional short name / alias.'),
        office: z
          .string()
          .optional()
          .describe('Office code (CompanyCode). Defaults to TWINFIELD_OFFICE_CODE.'),
      },
    },
    async ({ code, name, shortname, office }) => {
      try {
        const resolvedOffice = office ?? client.defaultOfficeCode;
        if (!resolvedOffice) {
          throw new Error('No office code provided and TWINFIELD_OFFICE_CODE is not set.');
        }

        const xmlParts = [
          `<office>${escapeXml(resolvedOffice)}</office>`,
          `<type>${escapeXml(spec.dimtype)}</type>`,
          `<code>${escapeXml(code)}</code>`,
          `<name>${escapeXml(name)}</name>`,
        ];
        if (shortname) xmlParts.push(`<shortname>${escapeXml(shortname)}</shortname>`);

        const result = await client.callProcessXml({
          office: resolvedOffice,
          xmlBody: `<dimensions><dimension>${xmlParts.join('')}</dimension></dimensions>`,
        });

        const normalized = normalizeDimensionUpsertResult(result);
        if (!normalized.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: normalized.error }, null, 2),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  office: resolvedOffice,
                  dimtype: spec.dimtype,
                  code: normalized.code,
                  name: normalized.name,
                  status: normalized.status,
                },
                null,
                2,
              ),
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

interface DimensionUpsertResult {
  success: boolean;
  code?: string;
  name?: string;
  status?: string;
  error?: string;
}

function normalizeDimensionUpsertResult(result: unknown): DimensionUpsertResult {
  if (!result || typeof result !== 'object') return { success: false, error: 'Empty response from Twinfield.' };
  const root = ((result as Record<string, unknown>)['dimensions'] ?? result) as Record<string, unknown>;
  const rootResult = root['@_result'];
  const dimRaw = root['dimension'];
  const dim = (Array.isArray(dimRaw) ? dimRaw[0] : dimRaw) as Record<string, unknown> | undefined;

  if (rootResult === 1 || rootResult === '1') {
    return {
      success: true,
      code: stringOrUndef(dim?.['code']),
      name: stringOrUndef(dim?.['name']),
      status: stringOrUndef(dim?.['@_status']),
    };
  }

  const dimMsg = dim?.['@_msg'];
  const rootMsg = root['@_msg'];
  return {
    success: false,
    error: (typeof dimMsg === 'string' ? dimMsg : typeof rootMsg === 'string' ? rootMsg : undefined) ??
      'Twinfield rejected the dimension upsert (no message returned).',
  };
}

function stringOrUndef(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) {
    const t = (v as Record<string, unknown>)['#text'];
    if (typeof t === 'string' || typeof t === 'number') return String(t);
  }
  return undefined;
}
