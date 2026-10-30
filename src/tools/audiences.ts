import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { AUDIENCE_DEFAULT_FIELDS } from "../meta/types/audience.js";
import type { CustomAudience, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";
import { audienceUsersInput, prepareAudienceUsers } from "../utils/audience-users.js";

export function registerAudienceTools(server: McpServer): void {
  // ─── Get Custom Audiences ─────────────────────────────────────
  server.registerTool(
    "ads_get_custom_audiences",
    {
      description:
        "List custom audiences for an ad account. Includes lookalikes, website audiences, customer lists, engagement audiences and offline-conversion audiences. Use the returned audience id with ads_update_ad_set (targeting.custom_audiences=[{id}]) to apply the audience to an ad set.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<CustomAudience>>(
        `/${id}/customaudiences`,
        { fields: fieldsParam, limit },
      );
      const audiences = response.data ?? [];

      const text =
        audiences.length === 0
          ? "No custom audiences found."
          : audiences
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — Type: ${a.subtype} — Size: ${a.approximate_count_lower_bound ?? "?"}-${a.approximate_count_upper_bound ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${audiences.length} audience(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(audiences, null, 2) },
        ],
      };
    },
  );

  // ─── Get Audience Details ─────────────────────────────────────
  server.registerTool(
    "ads_get_audience_details",
    {
      description:
        "Get detailed information about a specific custom audience, including subtype, retention period, approximate size bounds and lookalike spec. Useful before applying it to an ad set via ads_update_ad_set.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, fields }) => {
      const id = validateMetaId(audience_id, "audience");
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const audience = await metaApiClient.get<CustomAudience>(
        `/${id}`,
        { fields: fieldsParam },
      );

      return {
        content: [
          {
            type: "text",
            text: `Audience: ${audience.name} (${audience.id})\nType: ${audience.subtype}\nSize: ${audience.approximate_count_lower_bound ?? "?"}-${audience.approximate_count_upper_bound ?? "?"}`,
          },
          { type: "text", text: JSON.stringify(audience, null, 2) },
        ],
      };
    },
  );

  // ─── Create Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_create_custom_audience",
    {
      description: `${WRITE_WARNING}Create a custom audience on an ad account. Two main flows: (a) WEBSITE pixel-based — pass 'rule' (event_sources of type 'pixel') and OMIT 'subtype' (Meta v18+ infers it; passing subtype: WEBSITE returns error 2654). (b) CUSTOM customer-list — pass subtype: 'CUSTOM' + customer_file_source; PII must be SHA-256 hashed before uploading users. After creation: build a lookalike with ads_create_lookalike_audience and apply the id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]).`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Audience name"),
        description: z.string().optional().describe("Audience description"),
        subtype: z
          .enum(["CUSTOM", "WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT"])
          .optional()
          .describe(
            "Audience subtype. OMIT (or pass 'WEBSITE') when 'rule' is set — for pixel-based audiences Meta infers the subtype and rejects an explicit one (error 2654); the tool drops it automatically. For non-rule flows: when omitted, defaults to 'CUSTOM' (customer-list), which also requires customer_file_source.",
          ),
        customer_file_source: z
          .enum([
            "USER_PROVIDED_ONLY",
            "PARTNER_PROVIDED_ONLY",
            "BOTH_USER_AND_PARTNER_PROVIDED",
          ])
          .optional()
          .describe("Required only when subtype = 'CUSTOM' (customer-list)."),
        retention_days: z.number().optional().describe("Retention period in days"),
        rule: z
          .string()
          .optional()
          .describe(
            "JSON rule for pixel/event-based audiences (WEBSITE). Shape: {inclusions:{operator:'or',rules:[{event_sources:[{id:'<pixel_id>',type:'pixel'}],retention_seconds:<n>,filter:{operator:'and',filters:[{field:'event',operator:'=',value:'<event_name>'}]}}]}}. When 'rule' is set, omit 'subtype'.",
          ),
        prefill: z.boolean().optional().describe("Whether to prefill with existing data (for WEBSITE)"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, description, subtype, customer_file_source, retention_days, rule, prefill }) => {
      const id = normalizeAccountId(account_id);

      const effectiveSubtype = rule ? undefined : (subtype ?? "CUSTOM");

      if (effectiveSubtype === "CUSTOM" && !customer_file_source) {
        throw new Error(
          "subtype 'CUSTOM' requires customer_file_source. Use one of: USER_PROVIDED_ONLY, PARTNER_PROVIDED_ONLY, BOTH_USER_AND_PARTNER_PROVIDED.",
        );
      }

      const body: Record<string, string | number | boolean> = { name };

      if (effectiveSubtype) body.subtype = effectiveSubtype;
      if (description) body.description = description;
      if (customer_file_source) body.customer_file_source = customer_file_source;
      if (retention_days !== undefined) body.retention_days = retention_days;
      if (rule) body.rule = rule;
      if (prefill !== undefined) body.prefill = prefill;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/customaudiences`,
        body,
      );

      const reportedType = effectiveSubtype ?? "WEBSITE (inferred from rule)";
      return {
        content: [
          {
            type: "text",
            text: `Custom audience created!\nID: ${result.id}\nName: ${name}\nType: ${reportedType}`,
          },
        ],
      };
    },
  );

  // ─── Create Lookalike Audience ────────────────────────────────
  server.registerTool(
    "ads_create_lookalike_audience",
    {
      description: `${WRITE_WARNING}Create a lookalike audience seeded by an existing custom audience. Source must have ~100+ matched users or Meta rejects the request. Ratio controls similarity vs. reach (0.01 = closest 1%, 0.20 = top 20% — bigger reach, lower similarity). After creation, apply the lookalike id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]). Lookalikes typically need ~24 h to compute users — id is returned immediately but reach starts at zero.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Lookalike audience name"),
        origin_audience_id: z.string().describe("Source custom audience ID"),
        ratio: z.number().min(0.01).max(0.20).describe("Lookalike ratio (0.01 = 1%, 0.20 = 20%)"),
        country: z.string().describe("Target country ISO code (e.g., CO, US, MX)"),
        description: z.string().optional(),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, origin_audience_id, ratio, country, description }) => {
      const accountPath = normalizeAccountId(account_id);
      const originAudienceIdValidated = validateMetaId(origin_audience_id, "audience");

      const body: Record<string, string | number | boolean> = {
        name,
        subtype: "LOOKALIKE",
        origin_audience_id: originAudienceIdValidated,
        lookalike_spec: JSON.stringify({
          ratio,
          country,
          type: "similarity",
        }),
      };

      if (description) body.description = description;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${accountPath}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Lookalike audience created!\nID: ${result.id}\nName: ${name}\nSource: ${originAudienceIdValidated}\nRatio: ${(ratio * 100).toFixed(0)}%\nCountry: ${country}`,
          },
        ],
      };
    },
  );

  // ─── Share Custom Audience ────────────────────────────────────
  server.registerTool(
    "ads_share_custom_audience",
    {
      description: `${WRITE_WARNING}Share a custom audience with one or more ad accounts under the same Business Manager. Both source and target accounts must belong to the same BM and the caller needs ads_management on each. Shareable subtypes: CUSTOM, LOOKALIKE, WEBSITE (engagement/offline-conversion audiences cannot be shared — Meta returns code 2655). Re-sharing with the same account is a no-op. After sharing, the target account can target the audience via ads_update_ad_set (targeting.custom_audiences=[{id}]).`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to share"),
        ad_account_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "Target ad account IDs (numeric or act_<id>). Must be in the same Business Manager as the audience owner.",
          ),
        relationship_type: z
          .array(z.string())
          .optional()
          .describe('Optional relationship tags (e.g. ["AGENCY"]).'),
      },
      annotations: { ...UPDATE },
    },
    async ({ audience_id, ad_account_ids, relationship_type }) => {
      const id = validateMetaId(audience_id, "audience");
      const numericAccounts = ad_account_ids.map((a) =>
        normalizeAccountId(a).slice("act_".length),
      );

      const body: Record<string, string | number | boolean> = {
        adaccounts: JSON.stringify(numericAccounts),
      };
      if (relationship_type?.length) {
        body.relationship_type = JSON.stringify(relationship_type);
      }

      const response = await metaApiClient.postForm<{ success?: boolean }>(
        `/${id}/adaccounts`,
        body,
      );

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the share for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} shared with ${numericAccounts.length} account(s): ${numericAccounts.join(", ")}`,
          },
        ],
      };
    },
  );

  // ─── Unshare Custom Audience ──────────────────────────────────
  server.registerTool(
    "ads_unshare_custom_audience",
    {
      description: `${WRITE_WARNING}Revoke a custom audience share from one or more ad accounts. Only removes the share relationship — the audience itself remains on the owner account. Use ads_get_audience_shared_accounts first to confirm which accounts currently have access.`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to unshare"),
        ad_account_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "Ad account IDs to revoke (numeric or act_<id>).",
          ),
      },
      annotations: { ...UPDATE },
    },
    async ({ audience_id, ad_account_ids }) => {
      const id = validateMetaId(audience_id, "audience");
      const numericAccounts = ad_account_ids.map((a) =>
        normalizeAccountId(a).slice("act_".length),
      );

      const query = new URLSearchParams({
        adaccounts: JSON.stringify(numericAccounts),
      }).toString();

      const response = await metaApiClient.delete<{ success?: boolean }>(
        `/${id}/adaccounts?${query}`,
      );

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the unshare for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} unshared from ${numericAccounts.length} account(s): ${numericAccounts.join(", ")}`,
          },
        ],
      };
    },
  );

  // ─── Get Audience Shared Accounts ─────────────────────────────
  server.registerTool(
    "ads_get_audience_shared_accounts",
    {
      description:
        "List ad accounts that currently have shared access to a custom audience. Returns each account id + name. Use before ads_share_custom_audience / ads_unshare_custom_audience to audit the share set.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        limit: z.number().min(1).max(100).default(25),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, limit }) => {
      const id = validateMetaId(audience_id, "audience");

      const response = await metaApiClient.get<
        MetaApiResponse<{ account_id: string; id?: string; name?: string }>
      >(`/${id}/adaccounts`, { fields: "account_id,name", limit });

      const accounts = response.data ?? [];
      const text =
        accounts.length === 0
          ? "No shared accounts."
          : accounts
              .map(
                (a) =>
                  `• ${a.name ?? "(unnamed)"} (act_${a.account_id})`,
              )
              .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} is shared with ${accounts.length} account(s):\n\n${text}`,
          },
          { type: "text", text: JSON.stringify(accounts, null, 2) },
        ],
      };
    },
  );

  // ─── Delete Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_delete_custom_audience",
    {
      description: `${WRITE_WARNING}Permanently delete a custom audience from the ad account. Cannot be undone. To remove an audience from a single ad set without destroying it everywhere, prefer ads_update_ad_set with targeting.custom_audiences set to a different array (or omitted from a fresh targeting spec).`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ audience_id }) => {
      const id = validateMetaId(audience_id, "audience");
      const response = await metaApiClient.delete<{ success?: boolean }>(`/${id}`);

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the deletion for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          { type: "text", text: `Audience ${id} deleted successfully.` },
        ],
      };
    },
  );
  server.registerTool(
    "ads_add_custom_audience_users",
    {
      description: `${WRITE_WARNING}Add customer email/phone records to an existing CUSTOM customer-list audience. Normalizes, SHA-256 hashes and deduplicates locally; raw identifiers are never sent to Meta or returned. Phone numbers must include country codes (never inferred). Set pre_hashed=true only for existing 64-character SHA-256 hex digests. Up to 10000 records per call; split larger lists explicitly. dry_run defaults to true: preview counts locally without any API calls. To upload, set dry_run=false; verifies the audience belongs to account_id first. Does not create an audience, activate ads or guarantee matches/delivery. Use only a customer list you are authorized to upload; do not harvest chat contacts.`,
      inputSchema: audienceUsersInput.shape,
      annotations: { ...UPDATE },
    },
    async (input) => {
      const prepared = prepareAudienceUsers(input);
      const account = normalizeAccountId(prepared.account_id);
      const id = validateMetaId(prepared.audience_id, "audience");
      const counts = { audience_id: id, account_id: account, input_rows: prepared.users.length, unique_rows: prepared.payload.data.length, duplicate_rows: prepared.duplicates };
      if (prepared.dry_run) return { content: [{ type: "text", text: JSON.stringify({ ...counts, dry_run: true, uploaded: false, ownership_checked: false }) }] };
      const audience = await metaApiClient.get<{ account_id?: string; subtype?: string }>(`/${id}`, { fields: "id,account_id,subtype" });
      if (!audience.account_id || normalizeAccountId(audience.account_id) !== account) throw new Error("Audience does not belong to the selected ad account, or ownership could not be verified.");
      if (audience.subtype !== "CUSTOM") throw new Error("Only CUSTOM customer-list audiences accept this upload.");
      const result = await metaApiClient.post<{ audience_id?: string; num_received?: number; num_invalid_entries?: number }>(`/${id}/users`, { payload: prepared.payload });
      if (!Number.isInteger(result.num_received) || result.num_received! < 0) throw new Error("Meta did not confirm received rows. Check the audience before retrying; the upload outcome is unknown.");
      return { content: [{ type: "text", text: JSON.stringify({ ...counts, dry_run: false, uploaded: true, num_received: result.num_received, num_invalid_entries: result.num_invalid_entries ?? null, note: "Received rows are not matched users. Matching/availability must be checked separately; no ads were activated." }) }] };
    },
  );
}
