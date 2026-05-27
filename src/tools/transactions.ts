import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TwinfieldClient, type BrowseColumn, type BrowseRow } from '../twinfield-client.js';

/**
 * Register browse-based transaction read tools.
 *
 * Twinfield exposes its tabular reports via the ProcessXml `<columns code="…">`
 * query family. Browse code 100 (general transactions) is the workhorse — we
 * use it for `get_transactions`, `get_sales_invoices`, and `get_purchase_invoices`.
 *
 * The browse engine has known quirks that shaped this column set:
 *   - Amount fields ONLY work with the `…valuesigned` suffix
 *     (`fin.trs.line.valuesigned`, `fin.trs.line.openbasevaluesigned`).
 *     Using `basedebet`, `basecredit`, or the un-signed `basevalue` triggers
 *     a generic server fault or "Veld bestaat niet" error.
 *   - `fin.trs.line.dim1` is incompatible with `fin.trs.line.dim2` in
 *     certain combinations — we read only `dim2` (counterparty).
 *   - Date filtering on `fin.trs.head.date` does not accept `<operator>`;
 *     filter by `fin.trs.head.yearperiod` (`YYYY/PP` format) instead.
 *   - `head.code` (daybook) accepts `<operator>equal</operator>` filtering
 *     and is the canonical way to scope to a journal type.
 */
export function registerTransactionTools(server: McpServer, client: TwinfieldClient): void {
  registerTransactionsListTool(server, client, {
    name: 'get_transactions',
    defaultDaybook: undefined,
    description:
      'List transactions from a Twinfield office. Each row is one transaction line with ' +
      'daybook code, number, date, year-period, counterparty, match status, amount, and open amount. ' +
      'Filter by `daybook` (e.g. `VRK` for sales, `INK` for purchases, `BNK` for bank), ' +
      'and by year-period range (`YYYY/PP`). Run `get_transactions` once without filters to see ' +
      'which daybook codes exist on this office.',
  });

  registerTransactionsListTool(server, client, {
    name: 'get_sales_invoices',
    defaultDaybook: 'VRK',
    description:
      'List sales invoice transactions (Twinfield daybook `VRK` by default). ' +
      'Each row is one invoice line with date, customer code, match status, amount, and open amount. ' +
      'Pass `openOnly=true` to keep only rows whose match status is `available` (unpaid).',
  });

  registerTransactionsListTool(server, client, {
    name: 'get_purchase_invoices',
    defaultDaybook: 'INK',
    description:
      'List purchase invoice transactions (Twinfield daybook `INK` by default). ' +
      'Each row is one invoice line with date, supplier code, match status, amount, and open amount. ' +
      'Pass `openOnly=true` to keep only rows whose match status is `available` (unpaid).',
  });
}

interface TransactionToolSpec {
  name: string;
  defaultDaybook: string | undefined;
  description: string;
}

const FIELD = {
  daybook: 'fin.trs.head.code',
  number: 'fin.trs.head.number',
  date: 'fin.trs.head.date',
  yearperiod: 'fin.trs.head.yearperiod',
  counterparty: 'fin.trs.line.dim2',
  matchstatus: 'fin.trs.line.matchstatus',
  amount: 'fin.trs.line.valuesigned',
  openAmount: 'fin.trs.line.openbasevaluesigned',
} as const;

function registerTransactionsListTool(
  server: McpServer,
  client: TwinfieldClient,
  spec: TransactionToolSpec,
): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe('Office code (CompanyCode). Defaults to TWINFIELD_OFFICE_CODE.'),
        daybook: z
          .string()
          .optional()
          .describe(
            spec.defaultDaybook
              ? `Twinfield daybook code (defaults to \`${spec.defaultDaybook}\`). Pass a different code to override.`
              : 'Twinfield daybook code (e.g. `VRK`, `INK`, `BNK`, `MEMO`). Leave empty for all daybooks.',
          ),
        yearperiodFrom: z
          .string()
          .optional()
          .describe('Inclusive start of the year-period filter in `YYYY/PP` format, e.g. `2024/01`.'),
        yearperiodTo: z
          .string()
          .optional()
          .describe('Inclusive end of the year-period filter in `YYYY/PP` format, e.g. `2024/12`.'),
        counterparty: z
          .string()
          .optional()
          .describe('Filter to a single customer/supplier code (matched on `fin.trs.line.dim2`).'),
        openOnly: z
          .boolean()
          .optional()
          .describe(
            'When true, keep only rows whose match status is `available` (unpaid). ' +
              'Applied as a post-filter on the response — Twinfield rejects matchstatus filters at the column level.',
          ),
      },
    },
    async ({ office, daybook, yearperiodFrom, yearperiodTo, counterparty, openOnly }) => {
      try {
        const effectiveDaybook = daybook ?? spec.defaultDaybook;
        if ((yearperiodFrom && !yearperiodTo) || (!yearperiodFrom && yearperiodTo)) {
          throw new Error('yearperiodFrom and yearperiodTo must be supplied together.');
        }

        const columns: BrowseColumn[] = [
          {
            field: FIELD.daybook,
            label: 'Daybook',
            ...(effectiveDaybook
              ? { filter: { operator: 'equal' as const, from: effectiveDaybook } }
              : {}),
          },
          { field: FIELD.number, label: 'Number' },
          { field: FIELD.date, label: 'Date' },
          {
            field: FIELD.yearperiod,
            label: 'Period',
            ...(yearperiodFrom && yearperiodTo
              ? { filter: { operator: 'between' as const, from: yearperiodFrom, to: yearperiodTo } }
              : {}),
          },
          {
            field: FIELD.counterparty,
            label: 'Counterparty',
            ...(counterparty ? { filter: { operator: 'equal' as const, from: counterparty } } : {}),
          },
          { field: FIELD.matchstatus, label: 'MatchStatus' },
          { field: FIELD.amount, label: 'Amount' },
          { field: FIELD.openAmount, label: 'OpenAmount' },
        ];

        const result = await client.callBrowse({
          office,
          code: '100',
          columns,
        });

        let transactions = result.rows.map(rowToTransaction);
        if (openOnly) {
          transactions = transactions.filter((t) => t.matchStatus === 'available');
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  daybook: effectiveDaybook ?? null,
                  yearperiodFrom: yearperiodFrom ?? null,
                  yearperiodTo: yearperiodTo ?? null,
                  count: transactions.length,
                  total: result.total ?? null,
                  transactions,
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

interface Transaction {
  daybook: string | undefined;
  number: number | string | undefined;
  date: string | undefined;
  yearperiod: string | undefined;
  counterparty: string | undefined;
  matchStatus: string | undefined;
  matchStatusLabel: string | undefined;
  amount: number | undefined;
  openAmount: number | undefined;
  key: Record<string, unknown>;
}

function rowToTransaction(row: BrowseRow): Transaction {
  const cells = row.cells;
  return {
    daybook: cellString(cells[FIELD.daybook]),
    number: cellNumberOrString(cells[FIELD.number]),
    // Prefer Twinfield's formatted "DD/MM/YYYY" name when present, fall back to the YYYYMMDD value.
    date: cells[FIELD.date]?.formatted ?? cellString(cells[FIELD.date]),
    yearperiod: cellString(cells[FIELD.yearperiod]),
    counterparty: cellString(cells[FIELD.counterparty]),
    matchStatus: cellString(cells[FIELD.matchstatus]),
    matchStatusLabel: cells[FIELD.matchstatus]?.formatted,
    amount: cellNumber(cells[FIELD.amount]),
    openAmount: cellNumber(cells[FIELD.openAmount]),
    key: row.key,
  };
}

function cellString(cell: { value: unknown } | undefined): string | undefined {
  if (!cell) return undefined;
  if (typeof cell.value === 'string') return cell.value;
  if (typeof cell.value === 'number') return String(cell.value);
  return undefined;
}

function cellNumber(cell: { value: unknown } | undefined): number | undefined {
  if (!cell) return undefined;
  if (typeof cell.value === 'number') return cell.value;
  if (typeof cell.value === 'string') {
    const n = Number(cell.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function cellNumberOrString(cell: { value: unknown } | undefined): number | string | undefined {
  if (!cell) return undefined;
  if (typeof cell.value === 'number') return cell.value;
  if (typeof cell.value === 'string') return cell.value;
  return undefined;
}
