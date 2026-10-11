import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import {
  AD_ACCOUNT_DEFAULT_FIELDS,
  AD_ACCOUNT_DETAIL_FIELDS,
  PAGE_DEFAULT_FIELDS,
} from "../meta/types/account.js";
import type {
  AdAccount,
  Page,
  MetaApiResponse,
} from "../meta/types/index.js";
import { READ } from "./_register.js";

export function registerAccountTools(server: McpServer): void {
  // ─── Get Ad Accounts ─────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_accounts",
    {
      description:
        "Get all ad accounts accessible by the authenticated user. Returns account names, IDs, status, currency, and spend information.",
      inputSchema: {
        user_id: z
          .string()
          .default("me")
          .describe("User ID or 'me' for the authenticated user"),
        limit: z
          .number()
          .min(1)
          .max(500)
          .default(100)
          .describe("Maximum number of accounts to return"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Fields to include (defaults to standard set)"),
      },
      annotations: { ...READ },
    },
    async ({ user_id, limit, fields }) => {
      const userPath = user_id === "me" ? "me" : validateMetaId(user_id, "user");
      const fieldsParam = buildFieldsParam(
        fields,
        [...AD_ACCOUNT_DEFAULT_FIELDS],
      );

      const response = await metaApiClient.get<MetaApiResponse<AdAccount>>(
        `/${userPath}/adaccounts`,
        { fields: fieldsParam, limit },
      );

      const accounts = response.data ?? [];

      const text = accounts.length === 0
        ? "No ad accounts found for this user."
        : accounts
            .map((a) => {
              // A caller's own `fields` may leave any of these out: a field
              // that was not requested is not printed, least of all as a
              // status of DISABLED.
              const reference = a.account_id ?? a.id;
              return [
                `• ${a.name ? `${a.name} (${reference})` : reference}`,
                ...(a.account_status !== undefined ? [`Status: ${a.account_status === 1 ? "ACTIVE" : "DISABLED"}`] : []),
                ...(a.currency !== undefined ? [`Currency: ${a.currency}`] : []),
                `Spent: ${a.amount_spent ?? "N/A"}`,
              ].join(" — ");
            })
            .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${accounts.length} ad account(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(accounts, null, 2) },
        ],
      };
    },
  );

  // ─── Get Account Info ────────────────────────────────────────
  server.registerTool(
    "ads_get_account_info",
    {
      description:
        "Get detailed information about a specific ad account including spend, balance, capabilities, and business details.",
      inputSchema: {
        account_id: z
          .string()
          .describe("Ad account ID (with or without 'act_' prefix)"),
      },
      annotations: { ...READ },
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = [...AD_ACCOUNT_DETAIL_FIELDS].join(",");

      const account = await metaApiClient.get<AdAccount>(`/${id}`, {
        fields: fieldsParam,
      });

      return {
        content: [
          {
            type: "text",
            text: `Account: ${account.name} (${account.account_id})\nStatus: ${account.account_status === 1 ? "ACTIVE" : "DISABLED"}\nCurrency: ${account.currency}\nTimezone: ${account.timezone_name}\nSpent: ${account.amount_spent ?? "N/A"}\nBalance: ${account.balance ?? "N/A"}\nSpend Cap: ${account.spend_cap ?? "None"}`,
          },
          { type: "text", text: JSON.stringify(account, null, 2) },
        ],
      };
    },
  );

  // ─── Get Pages For Business ──────────────────────────────────
  server.registerTool(
    "ads_get_pages_for_business",
    {
      description:
        "Get Facebook Pages associated with an ad account or the authenticated user. Pages are required for creating ad creatives.",
      inputSchema: {
        account_id: z
          .string()
          .optional()
          .describe(
            "Ad account ID to get associated pages. Omit to get user's own pages.",
          ),
      },
      annotations: { ...READ },
    },
    async ({ account_id }) => {
      const fieldsParam = [...PAGE_DEFAULT_FIELDS].join(",");

      let pages: Page[];

      if (account_id) {
        const id = normalizeAccountId(account_id);
        // Try promoted_pages first, then owned_pages
        try {
          const response = await metaApiClient.get<MetaApiResponse<Page>>(
            `/${id}/promote_pages`,
            { fields: fieldsParam },
          );
          pages = response.data ?? [];
        } catch {
          const response = await metaApiClient.get<MetaApiResponse<Page>>(
            `/${id}/owned_pages`,
            { fields: fieldsParam },
          );
          pages = response.data ?? [];
        }
      } else {
        const response = await metaApiClient.get<MetaApiResponse<Page>>(
          "/me/accounts",
          { fields: fieldsParam },
        );
        pages = response.data ?? [];
      }

      const text =
        pages.length === 0
          ? "No pages found."
          : pages
              .map(
                (p) => `• ${p.name} (ID: ${p.id}) — Category: ${p.category ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${pages.length} page(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(pages, null, 2) },
        ],
      };
    },
  );
}
