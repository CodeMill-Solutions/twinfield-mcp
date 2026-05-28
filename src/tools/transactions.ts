import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TwinfieldClient,
  escapeXml,
  padDimensionCode,
  type BrowseColumn,
  type BrowseRow,
} from '../twinfield-client.js';

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

  registerProcessJournalTool(server, client);
  registerProcessInvoiceTool(server, client, {
    name: 'process_sales_invoice',
    daybook: 'VRK',
    side: 'sales',
  });
  registerProcessInvoiceTool(server, client, {
    name: 'process_purchase_invoice',
    daybook: 'INK',
    side: 'purchase',
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

// ── process_journal (write) ──────────────────────────────────────────────────

/**
 * Register `process_journal` — post a general journal entry (memoriaal).
 *
 * Twinfield's `<transaction>` write uses a `destiny` attribute (NOT
 * `status`) with values `temporary` (draft, editable in the UI) or `final`
 * (committed). We default to `temporary` so an agent can safely propose a
 * booking that the user reviews and finalises in the Twinfield UI.
 *
 * Lines must balance to zero — sum of debit equals sum of credit. We
 * validate this client-side so the agent gets a fast, clear error instead
 * of a less-helpful Twinfield response.
 *
 * Dimension codes are auto-padded to 4 digits when they're purely numeric.
 * This works around Twinfield's read-write inconsistency: reads return
 * `110` but writes require the storage form `0110`.
 */
function registerProcessJournalTool(server: McpServer, client: TwinfieldClient): void {
  const journalLineSchema = z.object({
    dim1: z
      .string()
      .min(1)
      .describe('Primary dimension code — usually the GL account. Numeric codes are auto-padded to 4 digits.'),
    dim2: z
      .string()
      .optional()
      .describe('Secondary dimension code — usually a customer or supplier. Auto-padded like dim1.'),
    dim3: z
      .string()
      .optional()
      .describe('Tertiary dimension — usually a cost centre or project. Auto-padded like dim1.'),
    value: z.number().describe('Line amount in the transaction currency. Always positive; the `debitcredit` field carries the sign.'),
    debitcredit: z.enum(['debit', 'credit']).describe('Whether this line is a debit or credit posting.'),
    description: z.string().optional().describe('Free-text line description.'),
  });

  server.registerTool(
    'process_journal',
    {
      description:
        'Post a general journal entry (memoriaal). Lines must balance to zero — the sum of ' +
        'debit values must equal the sum of credit values. Defaults to `destiny="temporary"` ' +
        'so the entry lands as a draft that you can review and finalise in the Twinfield UI; ' +
        'pass `destiny="final"` only when you are sure. Returns the Twinfield transaction number ' +
        'on success — look it up under the daybook in the UI to verify.',
      inputSchema: {
        office: z
          .string()
          .optional()
          .describe('Office code (CompanyCode). Defaults to TWINFIELD_OFFICE_CODE.'),
        daybook: z
          .string()
          .optional()
          .default('MEMO')
          .describe('Daybook code, e.g. `MEMO` for memorial entries (default), or any other ' +
            'configured journal code.'),
        date: z.string().describe('Booking date in `YYYY-MM-DD` or `YYYYMMDD` format.'),
        period: z
          .string()
          .regex(/^\d{4}\/\d{2}$/, 'Period must be in YYYY/PP format, e.g. 2024/01')
          .describe('Fiscal period in `YYYY/PP` format. Must match the booking date\'s fiscal period.'),
        currency: z.string().optional().default('EUR').describe('ISO currency code, e.g. `EUR`. Defaults to EUR.'),
        lines: z
          .array(journalLineSchema)
          .min(2)
          .describe('Journal lines. Must contain at least 2 lines and their debit/credit values must sum to zero.'),
        destiny: z
          .enum(['temporary', 'final'])
          .optional()
          .default('temporary')
          .describe('`temporary` (default, safe) creates a draft you can review in Twinfield. ' +
            '`final` commits the entry immediately.'),
      },
    },
    async ({ office, daybook, date, period, currency, lines, destiny }) => {
      try {
        const resolvedOffice = office ?? client.defaultOfficeCode;
        if (!resolvedOffice) {
          throw new Error('No office code provided and TWINFIELD_OFFICE_CODE is not set.');
        }

        // Belt-and-braces defaults — the MCP SDK doesn't always apply Zod
        // `.default()` to the parsed args, so we resolve them explicitly.
        const effectiveDaybook = daybook ?? 'MEMO';
        const effectiveCurrency = currency ?? 'EUR';
        const effectiveDestiny = destiny ?? 'temporary';

        // Balance validation
        const totalDebit = lines.filter((l) => l.debitcredit === 'debit').reduce((s, l) => s + l.value, 0);
        const totalCredit = lines.filter((l) => l.debitcredit === 'credit').reduce((s, l) => s + l.value, 0);
        if (Math.abs(totalDebit - totalCredit) > 0.005) {
          throw new Error(
            `Journal lines do not balance: debit total ${totalDebit.toFixed(2)} ≠ credit total ${totalCredit.toFixed(2)}.`,
          );
        }

        const normalizedDate = normalizeJournalDate(date);
        const lineXml = lines
          .map((l, i) => {
            const parts = [
              `<dim1>${escapeXml(padDimensionCode(l.dim1))}</dim1>`,
              ...(l.dim2 ? [`<dim2>${escapeXml(padDimensionCode(l.dim2))}</dim2>`] : []),
              ...(l.dim3 ? [`<dim3>${escapeXml(padDimensionCode(l.dim3))}</dim3>`] : []),
              `<value>${l.value.toFixed(2)}</value>`,
              `<debitcredit>${l.debitcredit}</debitcredit>`,
              ...(l.description ? [`<description>${escapeXml(l.description)}</description>`] : []),
            ];
            return `<line id="${i + 1}">${parts.join('')}</line>`;
          })
          .join('');

        const xmlBody = `<transaction destiny="${escapeXml(effectiveDestiny)}">
          <header>
            <office>${escapeXml(resolvedOffice)}</office>
            <code>${escapeXml(effectiveDaybook)}</code>
            <date>${escapeXml(normalizedDate)}</date>
            <period>${escapeXml(period)}</period>
            <currency>${escapeXml(effectiveCurrency)}</currency>
          </header>
          <lines>${lineXml}</lines>
        </transaction>`;

        const result = await client.callProcessXml({ office: resolvedOffice, xmlBody });

        const normalized = normalizeJournalResult(result);
        if (!normalized.success) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ success: false, error: normalized.error }, null, 2) },
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
                  daybook: effectiveDaybook,
                  number: normalized.number,
                  date: normalizedDate,
                  period,
                  destiny: effectiveDestiny,
                  lineCount: lines.length,
                  totalAmount: totalDebit,
                  note:
                    effectiveDestiny === 'temporary'
                      ? 'Entry posted as a temporary draft. Open it in Twinfield to review and finalise.'
                      : 'Entry posted as final.',
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

function normalizeJournalDate(input: string): string {
  // Accept YYYY-MM-DD, YYYY/MM/DD, or YYYYMMDD; emit YYYYMMDD.
  const digits = input.replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`Could not parse date "${input}". Use YYYY-MM-DD or YYYYMMDD.`);
  }
  return digits;
}

interface JournalResult {
  success: boolean;
  number?: number | string;
  error?: string;
}

function normalizeJournalResult(result: unknown): JournalResult {
  if (!result || typeof result !== 'object') return { success: false, error: 'Empty response from Twinfield.' };
  const tx = ((result as Record<string, unknown>)['transaction'] ?? result) as Record<string, unknown>;
  const r = tx['@_result'];

  if (r === 1 || r === '1') {
    const headerRaw = tx['header'];
    const header = (Array.isArray(headerRaw) ? headerRaw[0] : headerRaw) as Record<string, unknown> | undefined;
    const num = header?.['number'];
    return { success: true, number: typeof num === 'number' || typeof num === 'string' ? num : undefined };
  }

  // Collect every `@_msg` Twinfield set anywhere in the response.
  // Errors can appear at the transaction level, the line level, or — most
  // commonly — on the individual field (e.g. `line.dim1.@_msg` when the
  // dimension code isn't recognised).
  const messages: string[] = [];
  collectErrorMessages(tx, '', messages);
  return {
    success: false,
    error:
      messages.length > 0
        ? messages.join(' | ')
        : 'Twinfield rejected the journal (no message returned).',
  };
}

// ── process_sales_invoice / process_purchase_invoice (writes) ────────────────

interface InvoiceToolSpec {
  name: string;
  /** Daybook code used by default (`VRK` for sales, `INK` for purchase). */
  daybook: string;
  /** Determines debit/credit signs and which counterparty label we use. */
  side: 'sales' | 'purchase';
}

/**
 * Register a sales- or purchase-invoice write tool.
 *
 * Twinfield invoice bookings reuse the same `<transaction>` envelope as
 * journal entries, but with:
 *   - daybook = VRK (sales) or INK (purchase)
 *   - `<invoicenumber>` and `<duedate>` in the header
 *   - a `type="total"` line carrying dim1=debtor/creditor GL (default 1300
 *     for sales / 1600 for purchase) and dim2=counterparty code
 *   - one or more revenue/cost lines with optional `<vatcode>` — Twinfield
 *     auto-derives the VAT booking from the vatcode rather than requiring a
 *     separate VAT line in the XML
 *
 * Sign convention:
 *   - Sales invoice (we receive money later): total = debit, revenue = credit
 *   - Purchase invoice (we owe money): total = credit, cost = debit
 *
 * `destiny="temporary"` is the safe default — the invoice lands as a draft
 * the user can review in the Twinfield UI before finalising.
 */
function registerProcessInvoiceTool(server: McpServer, client: TwinfieldClient, spec: InvoiceToolSpec): void {
  const isSales = spec.side === 'sales';
  const counterpartyLabel = isSales ? 'customer' : 'supplier';
  const counterpartyKind = isSales ? 'DEB' : 'CRD';
  const defaultTotalGL = isSales ? '1300' : '1600';
  const totalGLLabel = isSales ? 'debtor (Debiteuren, typically 1300)' : 'creditor (Crediteuren, typically 1600)';
  const lineGLLabel = isSales ? 'revenue GL (P&L)' : 'cost / expense GL (P&L)';

  const invoiceLineSchema = z.object({
    glAccount: z.string().min(1).describe(`The ${lineGLLabel}. Numeric codes are auto-padded to 4 digits.`),
    amount: z
      .number()
      .describe(
        'Net amount (excluding VAT) for this line. Always positive — the sign is derived from the invoice side.',
      ),
    vatCode: z
      .string()
      .optional()
      .describe(
        'Twinfield VAT code (e.g. `VH` for hoog tarief 21%, `VL` for laag tarief 9%, `VN` for nul/vrijgesteld). ' +
          'Twinfield auto-generates the VAT booking; you only need to supply the code, not a separate VAT line.',
      ),
    description: z.string().optional().describe('Free-text description for this invoice line.'),
    costCenter: z.string().optional().describe('Optional cost-centre code (becomes dim3).'),
  });

  server.registerTool(
    spec.name,
    {
      description:
        `Book a ${spec.side} invoice via Twinfield's ${spec.daybook} daybook. The total line ` +
        `lands on the ${totalGLLabel} account; each invoice line is posted to its own P&L ` +
        `account with an optional VAT code that Twinfield uses to auto-generate the VAT booking. ` +
        `Defaults to \`destiny="temporary"\` (draft) so you can review the invoice in the ` +
        `Twinfield UI before finalising. Returns the assigned transaction number on success.`,
      inputSchema: {
        office: z.string().optional().describe('Office code. Defaults to TWINFIELD_OFFICE_CODE.'),
        daybook: z
          .string()
          .optional()
          .describe(`Daybook code. Defaults to \`${spec.daybook}\`.`),
        date: z.string().describe('Booking date in `YYYY-MM-DD` or `YYYYMMDD` format.'),
        period: z
          .string()
          .regex(/^\d{4}\/\d{2}$/, 'Period must be in YYYY/PP format, e.g. 2024/01')
          .describe('Fiscal period in `YYYY/PP` format.'),
        invoiceNumber: z
          .string()
          .min(1)
          .describe(`Invoice number as it appears on the printed invoice (your reference for the ${counterpartyLabel}).`),
        dueDate: z
          .string()
          .optional()
          .describe('Due date in `YYYY-MM-DD` or `YYYYMMDD` format. Optional — Twinfield can derive it from terms.'),
        [counterpartyLabel]: z
          .string()
          .min(1)
          .describe(`Code of the ${counterpartyLabel} (Twinfield dimension type ${counterpartyKind}).`),
        totalAmount: z
          .number()
          .positive()
          .describe('Gross invoice total (including VAT). Always positive.'),
        lines: z
          .array(invoiceLineSchema)
          .min(1)
          .describe('Invoice lines. Each line is one P&L posting with an optional VAT code.'),
        totalGLAccount: z
          .string()
          .optional()
          .describe(`GL code for the total line. Defaults to \`${defaultTotalGL}\` (${totalGLLabel}).`),
        currency: z.string().optional().describe('ISO currency code. Defaults to `EUR`.'),
        destiny: z
          .enum(['temporary', 'final'])
          .optional()
          .describe('`temporary` (default) creates a draft. `final` commits immediately.'),
      },
    },
    async (args) => {
      try {
        const office = (args as Record<string, unknown>)['office'] as string | undefined;
        const daybook = (args as Record<string, unknown>)['daybook'] as string | undefined;
        const date = (args as Record<string, unknown>)['date'] as string;
        const period = (args as Record<string, unknown>)['period'] as string;
        const invoiceNumber = (args as Record<string, unknown>)['invoiceNumber'] as string;
        const dueDate = (args as Record<string, unknown>)['dueDate'] as string | undefined;
        const counterparty = (args as Record<string, unknown>)[counterpartyLabel] as string;
        const totalAmount = (args as Record<string, unknown>)['totalAmount'] as number;
        const lines = (args as Record<string, unknown>)['lines'] as Array<{
          glAccount: string;
          amount: number;
          vatCode?: string;
          description?: string;
          costCenter?: string;
        }>;
        const totalGLAccount = (args as Record<string, unknown>)['totalGLAccount'] as string | undefined;
        const currency = (args as Record<string, unknown>)['currency'] as string | undefined;
        const destiny = (args as Record<string, unknown>)['destiny'] as 'temporary' | 'final' | undefined;

        const resolvedOffice = office ?? client.defaultOfficeCode;
        if (!resolvedOffice) {
          throw new Error('No office code provided and TWINFIELD_OFFICE_CODE is not set.');
        }

        const effectiveDaybook = daybook ?? spec.daybook;
        const effectiveCurrency = currency ?? 'EUR';
        const effectiveDestiny = destiny ?? 'temporary';
        const effectiveTotalGL = totalGLAccount ?? defaultTotalGL;
        const normalizedDate = normalizeJournalDate(date);
        const normalizedDueDate = dueDate ? normalizeJournalDate(dueDate) : undefined;

        // Sales: total=debit, revenue=credit. Purchase: total=credit, cost=debit.
        const totalSide = isSales ? 'debit' : 'credit';
        const lineSide = isSales ? 'credit' : 'debit';

        const headerParts = [
          `<office>${escapeXml(resolvedOffice)}</office>`,
          `<code>${escapeXml(effectiveDaybook)}</code>`,
          `<date>${escapeXml(normalizedDate)}</date>`,
          `<period>${escapeXml(period)}</period>`,
          `<currency>${escapeXml(effectiveCurrency)}</currency>`,
          `<invoicenumber>${escapeXml(invoiceNumber)}</invoicenumber>`,
          ...(normalizedDueDate ? [`<duedate>${escapeXml(normalizedDueDate)}</duedate>`] : []),
        ];

        const totalLineXml =
          `<line id="1" type="total">` +
          `<dim1>${escapeXml(padDimensionCode(effectiveTotalGL))}</dim1>` +
          `<dim2>${escapeXml(padDimensionCode(counterparty))}</dim2>` +
          `<value>${totalAmount.toFixed(2)}</value>` +
          `<debitcredit>${totalSide}</debitcredit>` +
          `<description>${escapeXml(`Invoice ${invoiceNumber}`)}</description>` +
          `</line>`;

        const detailLinesXml = lines
          .map((l, i) => {
            const parts = [
              `<dim1>${escapeXml(padDimensionCode(l.glAccount))}</dim1>`,
              ...(l.costCenter ? [`<dim3>${escapeXml(padDimensionCode(l.costCenter))}</dim3>`] : []),
              `<value>${l.amount.toFixed(2)}</value>`,
              `<debitcredit>${lineSide}</debitcredit>`,
              ...(l.vatCode ? [`<vatcode>${escapeXml(l.vatCode)}</vatcode>`] : []),
              ...(l.description ? [`<description>${escapeXml(l.description)}</description>`] : []),
            ];
            return `<line id="${i + 2}" type="detail">${parts.join('')}</line>`;
          })
          .join('');

        const xmlBody = `<transaction destiny="${escapeXml(effectiveDestiny)}">
          <header>${headerParts.join('')}</header>
          <lines>${totalLineXml}${detailLinesXml}</lines>
        </transaction>`;

        const result = await client.callProcessXml({ office: resolvedOffice, xmlBody });

        const normalized = normalizeJournalResult(result);
        if (!normalized.success) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ success: false, error: normalized.error }, null, 2) },
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
                  daybook: effectiveDaybook,
                  number: normalized.number,
                  invoiceNumber,
                  date: normalizedDate,
                  period,
                  destiny: effectiveDestiny,
                  [counterpartyLabel]: counterparty,
                  totalAmount,
                  lineCount: lines.length,
                  note:
                    effectiveDestiny === 'temporary'
                      ? 'Invoice posted as a temporary draft. Open it in Twinfield to review and finalise.'
                      : 'Invoice posted as final.',
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

function collectErrorMessages(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const msg = obj['@_msg'];
  if (typeof msg === 'string' && msg.length > 0) {
    out.push(path ? `${path}: ${msg}` : msg);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@_') || key === '#text') continue;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => collectErrorMessages(item, `${path ? path + '.' : ''}${key}[${idx}]`, out));
    } else {
      collectErrorMessages(value, path ? `${path}.${key}` : key, out);
    }
  }
}
