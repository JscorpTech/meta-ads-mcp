import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBillingTools } from "../../src/tools/billing.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerBillingTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 4 tools", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_billing_info",
      "ads_get_spend_limit",
      "ads_update_spend_cap",
      "ads_get_invoices",
    ]);
  });

  describe("ads_get_billing_info handler", () => {
    it("returns formatted billing info", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const mockBilling = {
        id: "act_123",
        name: "Test Account",
        currency: "USD",
        timezone_name: "America/New_York",
        spend_cap: "100000",
        amount_spent: "50000",
        balance: "20000",
        business_name: "Test Business",
        account_status: 1,
        funding_source_details: {
          id: "funding_1",
          display_string: "Visa ending in 4242",
          type: 1,
        },
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockBilling)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Test Account");
      expect(result.content[0].text).toContain("Test Business");
      expect(result.content[0].text).toContain("ACTIVE");
      expect(result.content[0].text).toContain("  Amount Spent: USD 500.00");
      expect(result.content[0].text).toContain("Visa ending in 4242");
    });
  });

  describe("ads_get_spend_limit handler", () => {
    it("returns spend limit info with usage percentage", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const mockSpend = {
        id: "act_123",
        name: "Test Account",
        currency: "USD",
        spend_cap: "100000",
        amount_spent: "75000",
        balance: "25000",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockSpend)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Amount Spent: USD 750.00");
      expect(result.content[0].text).toContain("75.0%");
    });
  });

  describe("ads_update_spend_cap handler", () => {
    type TextResult = { content: Array<{ type: string; text: string }> };
    const refusedRead = { error: { code: 100, type: "OAuthException", message: "Unsupported get request." } };

    /** POSTs succeed; the GET that follows answers with `readBack`, or is refused when there is none. */
    const setCap = async (spend_cap: number, readBack?: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return mockFetchResponse({ success: true });
        return readBack ? mockFetchResponse({ id: "act_123", ...readBack }) : mockFetchResponse(refusedRead, { status: 400 });
      }));
      const result = await server._registeredTools[2].handler({ account_id: "123", spend_cap }) as TextResult;
      return result.content[0].text;
    };

    const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname.replace(/^\/v[\d.]+/, ""),
      fields: new URL(String(url)).searchParams.get("fields"),
      body: init?.body ? Object.fromEntries(new URLSearchParams(init.body as string)) : undefined,
    }));

    it("sends a positive value exactly as the caller passed it", async () => {
      await setCap(1000000, { spend_cap: "100000000", amount_spent: "0", currency: "USD" });

      expect(calls()[0]).toEqual({ method: "POST", path: "/act_123", fields: null, body: { spend_cap: "1000000" } });
    });

    it("sends a value with decimals as it is", async () => {
      await setCap(23.5, { spend_cap: "2350", amount_spent: "0", currency: "USD" });

      expect(calls()[0].body).toEqual({ spend_cap: "23.5" });
    });

    it("removes the cap with spend_cap_action=delete: Meta ignores spend_cap=0", async () => {
      await setCap(0, { spend_cap: "0", amount_spent: "439924", currency: "USD" });

      expect(calls()[0]).toEqual({ method: "POST", path: "/act_123", fields: null, body: { spend_cap_action: "delete" } });
    });

    it("writes once, then reads the cap, the amount spent and the currency back", async () => {
      await setCap(1000000, { spend_cap: "100000000", amount_spent: "0", currency: "USD" });

      expect(calls().map((call) => `${call.method} ${call.path}`)).toEqual(["POST /act_123", "GET /act_123"]);
      expect(calls()[1].fields).toBe("spend_cap,amount_spent,currency");
    });

    it("USD: reports what Meta holds after the write, which is 100 times the number sent", async () => {
      const text = await setCap(1000000, { spend_cap: "100000000", amount_spent: "0", currency: "USD" });

      expect(text).toBe([
        "Spend cap updated for account 123.",
        "Sent: spend_cap=1000000 (in the account currency's standard unit)",
        "Spend cap now: USD 1,000,000.00 (read back from Meta)",
        "Amount spent now: USD 0.00 (read back from Meta)",
      ].join("\n"));
    });

    it("COP: reports what Meta holds after the write, in whole pesos", async () => {
      const text = await setCap(50000, { spend_cap: "50000", amount_spent: "0", currency: "COP" });

      expect(text).toBe([
        "Spend cap updated for account 123.",
        "Sent: spend_cap=50000 (in the account currency's standard unit)",
        "Spend cap now: COP 50,000 (read back from Meta)",
        "Amount spent now: COP 0 (read back from Meta)",
      ].join("\n"));
    });

    it("after a removal, reports that Meta holds no cap", async () => {
      const text = await setCap(0, { spend_cap: "0", amount_spent: "439924", currency: "USD" });

      expect(text).toBe([
        "Spend cap updated for account 123.",
        "Sent: spend_cap_action=delete",
        "Spend cap now: none (read back from Meta)",
        "Amount spent now: USD 4,399.24 (read back from Meta)",
      ].join("\n"));
    });

    it("after a removal, a cap Meta still holds is reported, not hidden behind 'removed'", async () => {
      const text = await setCap(0, { spend_cap: "100000000", amount_spent: "0", currency: "USD" });

      expect(text).toContain("Spend cap now: USD 1,000,000.00 (read back from Meta)");
      expect(text).not.toMatch(/removed|No limit/i);
    });

    // "none" is a claim about what Meta holds, so only an explicit zero earns
    // it. A read-back that leaves the field out, or sends null, confirms
    // nothing: after setting 500 it would otherwise say there is no cap.
    it("does not read a missing spend_cap field as 'no cap', after a removal", async () => {
      const text = await setCap(0, { amount_spent: "439924", currency: "USD" });

      expect(text).not.toContain("Spend cap now: none");
      expect(text).toContain("Spend cap now: not confirmed (Meta's read-back did not include it). Check with ads_get_spend_limit.");
      expect(text).toContain("Amount spent now: USD 4,399.24 (read back from Meta)");
    });

    it("does not read a missing or null spend_cap field as 'no cap', after setting one", async () => {
      const missing = await setCap(500, { amount_spent: "0", currency: "USD" });
      expect(missing).not.toContain("Spend cap now: none");
      expect(missing).toContain("Spend cap now: not confirmed");

      const nulled = await setCap(500, { spend_cap: null as unknown as string, amount_spent: "0", currency: "USD" });
      expect(nulled).not.toContain("Spend cap now: none");
      expect(nulled).toContain("Spend cap now: not confirmed");
    });

    it("when the read-back fails, says the write succeeded and that the value is unconfirmed", async () => {
      const text = await setCap(1000000);

      expect(text).toBe([
        "Spend cap updated for account 123.",
        "Sent: spend_cap=1000000 (in the account currency's standard unit)",
        "The write succeeded, but what Meta now holds could not be confirmed: the read-back failed. Check with ads_get_spend_limit.",
      ].join("\n"));
    });

    it("does not read anything back when the write fails", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(refusedRead, { status: 400 })));

      await expect(server._registeredTools[2].handler({ account_id: "123", spend_cap: 500 })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("ads_get_spend_limit request", () => {
    it("asks only for fields Meta's AdAccount reference lists", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "act_123", currency: "USD" })));

      await server._registeredTools[1].handler({ account_id: "123" });

      const fields = new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get("fields");
      expect(fields).toBe("id,name,currency,spend_cap,amount_spent,balance,min_daily_budget");
      expect(fields).not.toContain("daily_spend_limit");
    });

    it("no longer prints a daily spend limit", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ id: "act_123", currency: "USD", spend_cap: "100000", amount_spent: "75000", daily_spend_limit: "5000" }),
      ));

      const result = await server._registeredTools[1].handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).not.toContain("Daily Spend Limit");
    });
  });

  describe("amounts read from the account, in its own currency", () => {
    type TextResult = { content: Array<{ type: string; text: string }> };

    const read = async (toolIndex: number, account: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "act_123", name: "Cuenta", ...account })));
      const result = await server._registeredTools[toolIndex].handler({ account_id: "123" }) as TextResult;
      return result.content[0].text.split("\n");
    };

    it("ads_get_billing_info: a COP account's amounts are whole pesos", async () => {
      const lines = await read(0, { currency: "COP", amount_spent: "5000000", spend_cap: "10000000", balance: "250000" });

      expect(lines).toContain("Currency: COP");
      expect(lines).toContain("  Amount Spent: COP 5,000,000");
      expect(lines).toContain("  Spend Cap: COP 10,000,000");
      expect(lines).toContain("  Balance: COP 250,000");
    });

    it("ads_get_billing_info: a USD account's amounts are hundredths of a dollar", async () => {
      const lines = await read(0, { currency: "USD", amount_spent: "50000", spend_cap: "100000", balance: "20000" });

      expect(lines).toContain("  Amount Spent: USD 500.00");
      expect(lines).toContain("  Spend Cap: USD 1,000.00");
      expect(lines).toContain("  Balance: USD 200.00");
    });

    it("ads_get_billing_info: without a currency it shows the raw numbers and does not assume USD", async () => {
      const lines = await read(0, { amount_spent: "5000000", spend_cap: "10000000", balance: "250000" });

      expect(lines).toContain("Currency: N/A");
      expect(lines).toContain("  Amount Spent: 5000000 (in the account currency's minor unit)");
      expect(lines).toContain("  Spend Cap: 10000000 (in the account currency's minor unit)");
      expect(lines).toContain("  Balance: 250000 (in the account currency's minor unit)");
      expect(lines.join("\n")).not.toContain("USD");
    });

    it("ads_get_billing_info: keeps its words for an amount Meta did not send", async () => {
      const lines = await read(0, { currency: "COP" });

      expect(lines).toContain("  Amount Spent: N/A");
      expect(lines).toContain("  Spend Cap: No limit");
      expect(lines).toContain("  Balance: N/A");
    });

    it("ads_get_spend_limit: a COP account's amounts are whole pesos", async () => {
      const lines = await read(1, { currency: "COP", spend_cap: "10000000", amount_spent: "7500000", balance: "250000" });

      expect(lines).toContain("Spend Cap: COP 10,000,000");
      expect(lines).toContain("Amount Spent: COP 7,500,000");
      expect(lines).toContain("Remaining: COP 2,500,000");
      expect(lines).toContain("Usage: 75.0% of spend cap used");
      expect(lines).toContain("Balance: COP 250,000");
    });

    it("ads_get_spend_limit: a USD account's amounts are hundredths of a dollar", async () => {
      const lines = await read(1, { currency: "USD", spend_cap: "100000", amount_spent: "75000", balance: "25000" });

      expect(lines).toContain("Spend Cap: USD 1,000.00");
      expect(lines).toContain("Amount Spent: USD 750.00");
      expect(lines).toContain("Remaining: USD 250.00");
      expect(lines).toContain("Balance: USD 250.00");
    });

    it("ads_get_spend_limit: an overspent cap leaves a negative remainder in the same unit", async () => {
      const lines = await read(1, { currency: "COP", spend_cap: "1000000", amount_spent: "1250000" });

      expect(lines).toContain("Remaining: COP -250,000");
    });

    it("ads_get_spend_limit: without a currency it shows the raw numbers and does not assume USD", async () => {
      const lines = await read(1, { spend_cap: "10000000", amount_spent: "7500000", balance: "250000" });

      expect(lines).toContain("Spend Cap: 10000000 (in the account currency's minor unit)");
      expect(lines).toContain("Amount Spent: 7500000 (in the account currency's minor unit)");
      expect(lines).toContain("Remaining: 2500000 (in the account currency's minor unit)");
      expect(lines).toContain("Balance: 250000 (in the account currency's minor unit)");
      expect(lines.join("\n")).not.toContain("USD");
    });
  });

  describe("ads_get_invoices handler", () => {
    it("lists invoices for a business_id with their PDF links", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: [
            {
              id: "9001",
              invoice_id: "INV-2026-001",
              billing_period: "2026-05",
              amount_due: "1500.00",
              currency: "USD",
              payment_status: "PAID",
              due_date: "2026-06-15",
              download_uri: "https://business.facebook.com/invoice/INV-2026-001.pdf",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ business_id: "100" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0] as string).toContain("/100/business_invoices");
      expect(result.content[0].text).toContain("INV-2026-001");
      expect(result.content[0].text).toContain("PAID");
      expect(result.content[0].text).toContain("https://business.facebook.com/invoice/INV-2026-001.pdf");
    });

    it("resolves the business from account_id before fetching invoices", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ business: { id: "100", name: "Biz" } }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            data: [{ id: "9001", invoice_id: "INV-1", payment_status: "NOT_PAID" }],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ account_id: "123" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0] as string).toContain("/act_123");
      expect(fetchMock.mock.calls[1][0] as string).toContain("/100/business_invoices");
      expect(result.content[0].text).toContain("INV-1");
    });

    it("returns an explanatory message when there are no invoices", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ business_id: "100" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("No invoices found");
      expect(result.content[0].text).toContain("FINANCE");
    });

    it("throws when neither business_id nor account_id is provided", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const handler = server._registeredTools[3].handler;
      await expect(handler({})).rejects.toThrow(/business_id or account_id/);
    });
  });
});
