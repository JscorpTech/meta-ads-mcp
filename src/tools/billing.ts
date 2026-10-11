import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId, formatBudget } from "../utils/format.js";
import { formatMinorAmount } from "../meta/currency.js";
import { READ, UPDATE, WRITE_WARNING } from "./_register.js";

interface BillingInfo {
  id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  spend_cap?: string;
  amount_spent?: string;
  balance?: string;
  funding_source_details?: {
    id: string;
    display_string?: string;
    type?: number;
  };
  owner?: string;
  business_name?: string;
  account_status?: number;
  disable_reason?: number;
}

const BILLING_FIELDS = [
  "id",
  "name",
  "currency",
  "timezone_name",
  "spend_cap",
  "amount_spent",
  "balance",
  "funding_source_details",
  "owner",
  "business_name",
  "account_status",
  "disable_reason",
].join(",");

const SPEND_FIELDS = [
  "id",
  "name",
  "currency",
  "spend_cap",
  "amount_spent",
  "balance",
  "min_daily_budget",
].join(",");

const SPEND_CAP_READ_BACK_FIELDS = "spend_cap,amount_spent,currency";

interface SpendInfo {
  id: string;
  name?: string;
  currency?: string;
  spend_cap?: string;
  amount_spent?: string;
  balance?: string;
  min_daily_budget?: number;
}

interface Invoice {
  id: string;
  invoice_id?: string;
  advertiser_name?: string;
  amount?: string | number | Record<string, unknown>;
  amount_due?: string | number | Record<string, unknown>;
  billed_amount_details?: Record<string, unknown>;
  billing_period?: string;
  currency?: string;
  download_uri?: string;
  cdn_download_uri?: string;
  due_date?: string;
  entity?: string;
  invoice_date?: string;
  invoice_type?: string;
  liability_type?: string;
  payment_status?: string;
  payment_term?: string;
  type?: string;
  ad_account_ids?: string[];
}

const INVOICE_FIELDS = [
  "id",
  "invoice_id",
  "advertiser_name",
  "amount",
  "amount_due",
  "billed_amount_details",
  "billing_period",
  "currency",
  "download_uri",
  "cdn_download_uri",
  "due_date",
  "entity",
  "invoice_date",
  "invoice_type",
  "liability_type",
  "payment_status",
  "payment_term",
  "type",
  "ad_account_ids",
].join(",");

const INVOICE_TYPE = z.enum(["CM", "DM", "INV", "PRO_FORMA"]);

const ACCOUNT_STATUS_MAP: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

export function registerBillingTools(server: McpServer): void {
  // ─── Get Billing Info ─────────────────────────────────────────
  server.registerTool(
    "ads_get_billing_info",
    {
      description:
        "Get billing and payment information for an ad account, including funding source, account status, and spend data.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
      },
      annotations: { ...READ },
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);

      const info = await metaApiClient.get<BillingInfo>(
        `/${id}`,
        { fields: BILLING_FIELDS },
      );

      const currency = info.currency;
      const statusText = info.account_status !== undefined
        ? ACCOUNT_STATUS_MAP[info.account_status] ?? `UNKNOWN (${info.account_status})`
        : "N/A";

      const lines: string[] = [
        `Account: ${info.name ?? info.id}`,
        `Business: ${info.business_name ?? "N/A"}`,
        `Status: ${statusText}`,
        `Currency: ${currency ?? "N/A"}`,
        `Timezone: ${info.timezone_name ?? "N/A"}`,
        ``,
        `Spending:`,
        `  Amount Spent: ${info.amount_spent ? formatMinorAmount(info.amount_spent, currency) : "N/A"}`,
        `  Spend Cap: ${info.spend_cap ? formatMinorAmount(info.spend_cap, currency) : "No limit"}`,
        `  Balance: ${info.balance ? formatMinorAmount(info.balance, currency) : "N/A"}`,
      ];

      if (info.funding_source_details) {
        lines.push(
          ``,
          `Payment Method:`,
          `  ${info.funding_source_details.display_string ?? "N/A"} (ID: ${info.funding_source_details.id})`,
        );
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(info, null, 2) },
        ],
      };
    },
  );

  // ─── Get Spend Limit ──────────────────────────────────────────
  server.registerTool(
    "ads_get_spend_limit",
    {
      description:
        "Get spending limits and current spend for an ad account. Shows spend cap, amount spent, daily limits, and remaining balance.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
      },
      annotations: { ...READ },
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);

      const info = await metaApiClient.get<SpendInfo>(
        `/${id}`,
        { fields: SPEND_FIELDS },
      );

      const currency = info.currency;

      const spendCap = info.spend_cap ? parseInt(info.spend_cap, 10) : null;
      const amountSpent = info.amount_spent ? parseInt(info.amount_spent, 10) : null;
      const remaining =
        spendCap !== null && amountSpent !== null ? spendCap - amountSpent : null;

      const lines: string[] = [
        `Account: ${info.name ?? info.id}`,
        ``,
        `Spend Cap: ${spendCap !== null ? formatMinorAmount(spendCap, currency) : "No limit set"}`,
        `Amount Spent: ${amountSpent !== null ? formatMinorAmount(amountSpent, currency) : "N/A"}`,
      ];

      if (remaining !== null) {
        lines.push(`Remaining: ${formatMinorAmount(remaining, currency)}`);
        if (spendCap !== null && spendCap > 0) {
          const pctUsed = ((amountSpent! / spendCap) * 100).toFixed(1);
          lines.push(`Usage: ${pctUsed}% of spend cap used`);
        }
      }

      if (info.balance) lines.push(`Balance: ${formatMinorAmount(info.balance, currency)}`);
      if (info.min_daily_budget !== undefined) lines.push(`Min Daily Budget: ${formatBudget(info.min_daily_budget, currency ?? "USD")}`);

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(info, null, 2) },
        ],
      };
    },
  );

  // ─── Update Spend Cap ─────────────────────────────────────────
  server.registerTool(
    "ads_update_spend_cap",
    {
      description: `${WRITE_WARNING}Set or remove the spend cap of an ad account: the total it may spend before delivery stops. The cap is written in the account currency's standard unit, with decimals where the currency has them: 500 = USD 500.00, 50000 = COP 50,000. This is NOT the minor unit used for daily_budget and the other budgets, where USD 500.00 is 50000. Setting a cap restarts the account's amount-spent counter. 0 removes the cap. The result reports the cap and the amount spent that Meta holds afterwards.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        spend_cap: z
          .number()
          .min(0)
          .describe("New spend cap in the account currency's standard unit (500 = USD 500.00, 50000 = COP 50,000), not the minor unit used for budgets. 0 removes the cap."),
      },
      annotations: { ...UPDATE },
    },
    async ({ account_id, spend_cap }) => {
      const id = normalizeAccountId(account_id);

      // Meta ignores spend_cap=0 on this write; its documented way to remove
      // a cap is spend_cap_action=delete.
      const body: Record<string, string | number | boolean> = spend_cap > 0
        ? { spend_cap }
        : { spend_cap_action: "delete" };

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      const lines = [
        `Spend cap updated for account ${account_id}.`,
        spend_cap > 0
          ? `Sent: spend_cap=${spend_cap} (in the account currency's standard unit)`
          : "Sent: spend_cap_action=delete",
      ];

      // The cap is written in whole currency and read in the minor unit, so
      // what Meta holds afterwards is the only figure worth reporting.
      try {
        const held = await metaApiClient.get<Pick<SpendInfo, "spend_cap" | "amount_spent" | "currency">>(
          `/${id}`,
          { fields: SPEND_CAP_READ_BACK_FIELDS },
        );
        // "none" is a claim about what Meta holds: only an explicit zero
        // earns it. A read-back that leaves the field out confirms nothing.
        const cap = held.spend_cap;
        if (cap === undefined || cap === null) {
          lines.push("Spend cap now: not confirmed (Meta's read-back did not include it). Check with ads_get_spend_limit.");
        } else if (Number(cap) === 0) {
          lines.push("Spend cap now: none (read back from Meta)");
        } else {
          lines.push(`Spend cap now: ${formatMinorAmount(cap, held.currency)} (read back from Meta)`);
        }
        if (held.amount_spent !== undefined) {
          lines.push(`Amount spent now: ${formatMinorAmount(held.amount_spent, held.currency)} (read back from Meta)`);
        }
      } catch {
        lines.push("The write succeeded, but what Meta now holds could not be confirmed: the read-back failed. Check with ads_get_spend_limit.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Get Invoices ─────────────────────────────────────────────
  server.registerTool(
    "ads_get_invoices",
    {
      description:
        "Get invoices for a business (Meta's business_invoices), with their PDF download links. " +
        "Provide business_id directly, or account_id to resolve its business automatically. " +
        "Optionally filter by date range, invoice_id, or type. " +
        "Note: Meta only exposes invoices for businesses on a credit line / monthly invoicing, " +
        "and the access token needs the FINANCE_EDITOR or FINANCE_ANALYST role; card-billed accounts have no API invoices.",
      inputSchema: {
        business_id: z
          .string()
          .optional()
          .describe("Business ID. Either this or account_id is required."),
        account_id: z
          .string()
          .optional()
          .describe(
            "Ad account ID. Used to resolve the owning business when business_id is not given.",
          ),
        start_date: z
          .string()
          .optional()
          .describe("Filter invoices from this date (YYYY-MM-DD)."),
        end_date: z
          .string()
          .optional()
          .describe("Filter invoices up to this date (YYYY-MM-DD)."),
        invoice_id: z
          .string()
          .optional()
          .describe("Return a single invoice by its invoice_id."),
        type: INVOICE_TYPE.optional().describe(
          "Invoice type: CM (credit memo), DM (debit memo), INV (invoice), PRO_FORMA.",
        ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(25)
          .describe("Maximum number of invoices to return."),
      },
      annotations: { ...READ },
    },
    async ({ business_id, account_id, start_date, end_date, invoice_id, type, limit }) => {
      let businessId: string;
      if (business_id) {
        businessId = validateMetaId(business_id, "business_id");
      } else if (account_id) {
        const acct = await metaApiClient.get<{
          business?: { id: string; name?: string };
        }>(`/${normalizeAccountId(account_id)}`, { fields: "business" });
        if (!acct.business?.id) {
          throw new Error(
            `Ad account ${account_id} is not linked to a business, so it has no invoices. ` +
              `Meta exposes invoices only for businesses on a credit line / monthly invoicing.`,
          );
        }
        businessId = acct.business.id;
      } else {
        throw new Error("Provide either business_id or account_id to fetch invoices.");
      }

      const params: Record<string, string | number> = { fields: INVOICE_FIELDS };
      if (start_date) params.start_date = start_date;
      if (end_date) params.end_date = end_date;
      if (invoice_id) params.invoice_id = invoice_id;
      if (type) params.type = type;

      const invoices = await metaApiClient.getPaginated<Invoice>(
        `/${businessId}/business_invoices`,
        params,
        limit,
      );

      if (invoices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No invoices found for business ${businessId}.\n` +
                `Meta's business_invoices API only returns data for businesses on a ` +
                `credit line / monthly invoicing, and the access token must have the ` +
                `FINANCE_EDITOR or FINANCE_ANALYST role. Card-billed accounts have no ` +
                `invoices via the API — only receipts in Ads Manager.`,
            },
            { type: "text", text: "[]" },
          ],
        };
      }

      const renderAmount = (
        value: Invoice["amount"],
        currency?: string,
      ): string => {
        if (value === undefined || value === null) return "N/A";
        if (typeof value === "object") return JSON.stringify(value);
        return currency ? `${value} ${currency}` : String(value);
      };

      const lines: string[] = [
        `Found ${invoices.length} invoice(s) for business ${businessId}:`,
        ``,
      ];
      for (const inv of invoices) {
        const number = inv.invoice_id ?? inv.id;
        const period = inv.billing_period
          ? inv.billing_period
          : [inv.invoice_date, inv.due_date].filter(Boolean).join(" → ") || "N/A";
        const link = inv.download_uri ?? inv.cdn_download_uri;
        lines.push(
          `Invoice ${number}`,
          `  Period: ${period}`,
          `  Amount: ${renderAmount(inv.amount_due ?? inv.amount, inv.currency)}`,
          `  Status: ${inv.payment_status ?? "N/A"}`,
          `  Due: ${inv.due_date ?? "N/A"}`,
        );
        if (link) lines.push(`  PDF: ${link}`);
        lines.push(``);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n").trimEnd() },
          { type: "text", text: JSON.stringify(invoices, null, 2) },
        ],
      };
    },
  );
}
