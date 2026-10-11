import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import { MINOR_UNIT_NOTE } from "../meta/currency.js";
import { CREATE, WRITE_WARNING } from "./_register.js";

export function registerBudgetTools(server: McpServer): void {
  // ─── Create Budget Schedule ──────────────────────────────────
  server.registerTool(
    "ads_create_budget_schedule",
    {
      description: `${WRITE_WARNING}Schedule a temporary budget increase for a campaign during high-demand periods (e.g., Black Friday, product launches).`,
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID"),
        budget_value: z
          .string()
          .describe(`For ABSOLUTE, a budget amount ${MINOR_UNIT_NOTE}. For MULTIPLIER, the multiplier value.`),
        budget_value_type: z
          .enum(["ABSOLUTE", "MULTIPLIER"])
          .describe("ABSOLUTE = set exact budget (unit: see budget_value), MULTIPLIER = multiply current budget"),
        time_start: z.string().describe("ISO 8601 start time for the budget increase"),
        time_end: z.string().describe("ISO 8601 end time for the budget increase"),
      },
      annotations: { ...CREATE },
    },
    async ({ campaign_id, budget_value, budget_value_type, time_start, time_end }) => {
      const id = validateMetaId(campaign_id, "campaign");
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/budget_schedules`,
        {
          budget_value,
          budget_value_type,
          time_start,
          time_end,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: `Budget schedule created!\nID: ${result.id}\nCampaign: ${id}\nValue: ${budget_value} (${budget_value_type})\nPeriod: ${time_start} → ${time_end}`,
          },
        ],
      };
    },
  );
}
