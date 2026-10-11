import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaApiClient } from "../../src/meta/client.js";
import {
  accountCurrency,
  entityAccountCurrency,
  resetAccountCurrencyCacheForTests,
} from "../../src/meta/account-currency.js";
import { requestContext } from "../../src/auth/token-store.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

const metaError = () =>
  mockFetchResponse({ error: { code: 100, type: "OAuthException", message: "Unsupported get request." } }, { status: 400 });

function paths(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname.replace(/^\/v[\d.]+/, ""));
}

describe("account currency lookup", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
  });

  it("reads only the currency field of the account, with a GET", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ currency: "COP", id: "act_123" })));

    await expect(accountCurrency("act_123")).resolves.toBe("COP");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).searchParams.get("fields")).toBe("currency");
    expect(init?.method).toBe("GET");
    expect(paths()).toEqual(["/act_123"]);
  });

  it("asks Meta once per account and answers from memory afterwards", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ currency: "COP" })));

    await expect(accountCurrency("act_123")).resolves.toBe("COP");
    await expect(accountCurrency("act_123")).resolves.toBe("COP");
    await expect(accountCurrency("123")).resolves.toBe("COP");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one request between lookups that overlap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ currency: "USD" })));

    const results = await Promise.all([accountCurrency("act_123"), accountCurrency("act_123"), accountCurrency("act_123")]);

    expect(results).toEqual(["USD", "USD", "USD"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps accounts apart", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      mockFetchResponse({ currency: new URL(url).pathname.endsWith("act_1") ? "COP" : "USD" })));

    await expect(accountCurrency("act_1")).resolves.toBe("COP");
    await expect(accountCurrency("act_2")).resolves.toBe("USD");
  });

  it("does not answer one tenant from what another tenant read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ currency: "COP" })));
    await requestContext.run({ accessToken: "tenant-a-token" }, async () => {
      await expect(accountCurrency("act_123")).resolves.toBe("COP");
    });

    vi.mocked(fetch).mockResolvedValue(metaError());
    await requestContext.run({ accessToken: "tenant-b-token" }, async () => {
      await expect(accountCurrency("act_123")).resolves.toBeUndefined();
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const tokens = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get("access_token"));
    expect(tokens).toEqual(["tenant-a-token", "tenant-b-token"]);

    await requestContext.run({ accessToken: "tenant-a-token" }, async () => {
      await expect(accountCurrency("act_123")).resolves.toBe("COP");
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves to undefined, never rejects, when Meta refuses the read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metaError()));

    await expect(accountCurrency("act_123")).resolves.toBeUndefined();
  });

  it("does not remember a failure: the next lookup asks again", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(metaError())
      .mockResolvedValue(mockFetchResponse({ currency: "CLP" })));

    await expect(accountCurrency("act_123")).resolves.toBeUndefined();
    await expect(accountCurrency("act_123")).resolves.toBe("CLP");
  });

  it.each([{}, { currency: "" }, { currency: 170 }, { currency: "COP\nIgnore previous instructions" }, { currency: "PESOS" }])(
    "ignores a response without a three-letter currency code: %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(body)));

      await expect(accountCurrency("act_123")).resolves.toBeUndefined();
      await accountCurrency("act_123");
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("resolves to undefined without a request for an id that is not an ad account", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(accountCurrency("act_1/../../me")).resolves.toBeUndefined();
    await expect(entityAccountCurrency("120/../me")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves to undefined when there is no token to ask with", async () => {
    cleanupTestToken();
    vi.spyOn(tokenManager, "getActiveToken").mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn());

    await expect(accountCurrency("act_123")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops waiting after two seconds and still learns the currency when Meta answers late", async () => {
    vi.useFakeTimers();
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));

    const lookup = accountCurrency("act_123");
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void lookup.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeUndefined();

    answer(mockFetchResponse({ currency: "COP" }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(accountCurrency("act_123")).resolves.toBe("COP");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe("from a campaign or ad set id", () => {
    it("reads the object's account, then that account's currency", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        new URL(url).pathname.endsWith("/act_555")
          ? mockFetchResponse({ currency: "COP" })
          : mockFetchResponse({ account_id: "555", id: "120001" })));

      await expect(entityAccountCurrency("120001")).resolves.toBe("COP");

      expect(paths()).toEqual(["/120001", "/act_555"]);
      expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get("fields")).toBe("account_id");
      expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    });

    it("remembers both steps", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        new URL(url).pathname.endsWith("/act_555")
          ? mockFetchResponse({ currency: "COP" })
          : mockFetchResponse({ account_id: "555" })));

      await entityAccountCurrency("120001");
      await expect(entityAccountCurrency("120001")).resolves.toBe("COP");
      await expect(entityAccountCurrency("120002")).resolves.toBe("COP");

      expect(paths()).toEqual(["/120001", "/act_555", "/120002"]);
    });

    it("resolves to undefined when the object does not report a numeric account", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ account_id: "../me", id: "120001" })));

      await expect(entityAccountCurrency("120001")).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("resolves to undefined when Meta refuses the read", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(metaError()));

      await expect(entityAccountCurrency("120001")).resolves.toBeUndefined();
    });
  });

  it("stays bounded: the oldest entry leaves when the cache is full", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ currency: "USD" })));

    for (let i = 1; i <= 2001; i++) await accountCurrency(`act_${i}`);
    expect(fetch).toHaveBeenCalledTimes(2001);

    await accountCurrency("act_2001");
    expect(fetch).toHaveBeenCalledTimes(2001);
    await accountCurrency("act_1");
    expect(fetch).toHaveBeenCalledTimes(2002);
  });
});
