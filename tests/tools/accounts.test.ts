import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAccountTools } from "../../src/tools/accounts.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerAccountTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 3 tools", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(3);
  });

  it("registers ads_get_ad_accounts tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[0].name).toBe("ads_get_ad_accounts");
  });

  it("registers ads_get_account_info tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[1].name).toBe("ads_get_account_info");
  });

  it("registers ads_get_pages_for_business tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[2].name).toBe("ads_get_pages_for_business");
  });

  describe("ads_get_ad_accounts handler", () => {
    it("returns account data formatted correctly", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockData = {
        data: [
          {
            id: "act_123",
            account_id: "123",
            name: "Test Account",
            account_status: 1,
            currency: "USD",
            amount_spent: "5000",
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ user_id: "me", limit: 100, fields: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain("Found 1 ad account(s)");
      expect(result.content[0].text).toContain("Test Account");
      expect(result.content[0].text).toContain("ACTIVE");
    });

    const listWith = async (fields: string[] | undefined, account: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [account] })));
      const result = await server._registeredTools[0].handler({ user_id: "me", limit: 100, fields }) as {
        content: Array<{ type: string; text: string }>;
      };
      return result.content[0].text.split("\n").at(-1);
    };

    it("prints status, currency and spend with the default fields", async () => {
      const line = await listWith(undefined, {
        id: "act_123", account_id: "123", name: "Cuenta", account_status: 1, currency: "COP", amount_spent: "5000000",
      });

      expect(line).toBe("• Cuenta (123) — Status: ACTIVE — Currency: COP — Spent: 5000000");
    });

    it("still prints DISABLED for an account whose status is not 1", async () => {
      const line = await listWith(undefined, {
        id: "act_123", account_id: "123", name: "Cuenta", account_status: 2, currency: "USD", amount_spent: "0",
      });

      expect(line).toBe("• Cuenta (123) — Status: DISABLED — Currency: USD — Spent: 0");
    });

    it("prints neither a status nor a currency when the caller's fields left them out", async () => {
      const line = await listWith(["name", "amount_spent"], { id: "act_123", name: "Cuenta", amount_spent: "5000000" });

      expect(line).toBe("• Cuenta (act_123) — Spent: 5000000");
    });

    it("prints the one of the two that was requested", async () => {
      const line = await listWith(["account_id", "name", "currency"], { id: "act_123", account_id: "123", name: "Cuenta", currency: "COP" });

      expect(line).toBe("• Cuenta (123) — Currency: COP — Spent: N/A");
    });

    it("never prints the word undefined for a field that was not requested", async () => {
      const line = await listWith(["amount_spent"], { id: "act_123", amount_spent: "10" });

      expect(line).toBe("• act_123 — Spent: 10");
    });

    it("handles empty account list", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ user_id: "me", limit: 100, fields: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("No ad accounts found");
    });
  });

  describe("ads_get_account_info handler", () => {
    it("normalizes account ID and returns details", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockAccount = {
        id: "act_123",
        account_id: "123",
        name: "My Account",
        account_status: 1,
        currency: "USD",
        timezone_name: "America/New_York",
        amount_spent: "15000",
        balance: "5000",
        spend_cap: "100000",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockAccount)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("My Account");
      expect(result.content[0].text).toContain("ACTIVE");
      expect(result.content[0].text).toContain("America/New_York");

      // Verify the URL uses normalized account ID
      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("act_123");
    });

    const capLine = async (account: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "act_123", account_id: "123", name: "Cuenta", account_status: 1, currency: "USD",
        timezone_name: "America/Bogota", amount_spent: "35", balance: "0", ...account,
      })));
      const result = await server._registeredTools[1].handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };
      return result.content[0].text.split("\n").at(-1);
    };

    // Meta sends spend_cap "0" for an account without a cap.
    it("reads an account without a cap as 'None', not as a cap of 0", async () => {
      expect(await capLine({ spend_cap: "0" })).toBe("Spend Cap: None");
    });

    it.each([
      ["a missing field", {}],
      ["null", { spend_cap: null }],
      ["an empty string", { spend_cap: "" }],
      ["text", { spend_cap: "abc" }],
    ])("does not call a cap Meta did not report (%s) 'None'", async (_label, cap) => {
      expect(await capLine(cap)).toBe("Spend Cap: not reported by Meta");
    });

    it("still prints a cap that is set as the number Meta sent", async () => {
      expect(await capLine({ spend_cap: "100000" })).toBe("Spend Cap: 100000");
    });
  });

  describe("ads_get_pages_for_business handler", () => {
    it("returns pages for user when no account_id", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockData = {
        data: [
          { id: "6001", name: "My Page", category: "Business" },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[2].handler;
      const result = await handler({ account_id: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Found 1 page(s)");
      expect(result.content[0].text).toContain("My Page");

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("/me/accounts");
    });
  });
});
