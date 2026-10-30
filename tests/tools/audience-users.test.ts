import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAudienceTools } from "../../src/tools/audiences.js";
import { prepareAudienceUsers } from "../../src/utils/audience-users.js";
import { metaApiClient } from "../../src/meta/client.js";
import { createMockMcpServer } from "../setup.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const base = { account_id: "123", audience_id: "456" };
function tool() {
  const server = createMockMcpServer();
  registerAudienceTools(server as never);
  return server._registeredTools.find(t => t.name === "ads_add_custom_audience_users")!.handler;
}
afterEach(() => vi.restoreAllMocks());

describe("customer-list uploads", () => {
  it("normalizes multi-key records, preserves missing keys and deduplicates before upload", () => {
    const input = { ...base, users: [{ email: " TEST@Example.com ", phone: "+1 (202) 555-0100" }, { email: "test@example.com", phone: "0012025550100" }, { email: "other@example.com" }] };
    const prepared = prepareAudienceUsers(input);
    expect(prepared.payload).toEqual({ schema: ["EMAIL", "PHONE"], data: [[hash("test@example.com"), hash("12025550100")], [hash("other@example.com"), ""]] });
    expect(prepared.duplicates).toBe(1);
  });
  it("accepts pre-hashed values without hashing them twice", () => {
    const digest = hash("test@example.com");
    expect(prepareAudienceUsers({ ...base, pre_hashed: true, users: [{ email: digest.toUpperCase() }] }).payload.data).toEqual([[digest, ""]]);
  });
  it.each([
    [{}, false], [{ phone: "555abc123" }, false], [{ email: "not-an-email" }, false],
    [{ phone: "0123456789" }, false], [{ email: "plain@example.com" }, true],
  ])("rejects invalid records without exposing identifier values", (record, pre_hashed) => {
    expect(() => prepareAudienceUsers({ ...base, pre_hashed, users: [record] })).toThrow();
  });
  it("rejects empty and oversized lists", () => {
    expect(() => prepareAudienceUsers({ ...base, users: [] })).toThrow();
    expect(() => prepareAudienceUsers({ ...base, users: Array.from({ length: 10001 }, () => ({ email: "test@example.com" })) })).toThrow();
  });
  it("previews by default without any Meta requests or identifiers in output", async () => {
    const get = vi.spyOn(metaApiClient, "get"); const post = vi.spyOn(metaApiClient, "post");
    const response = await tool()({ ...base, users: [{ email: "test@example.com" }] });
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).toContain('\\"uploaded\\":false');
    expect(JSON.stringify(response)).not.toContain("test@example.com");
    expect(JSON.stringify(response)).not.toContain(hash("test@example.com"));
  });
  it("uploads only hashes to the selected audience and returns counts, never invalid-entry data", async () => {
    const get = vi.spyOn(metaApiClient, "get").mockResolvedValue({ account_id: "123", subtype: "CUSTOM" });
    const post = vi.spyOn(metaApiClient, "post").mockResolvedValue({ audience_id: "456", num_received: 1, num_invalid_entries: 0, invalid_entries: ["do-not-expose"] });
    const response = await tool()({ ...base, dry_run: false, users: [{ phone: "+1 202 555 0100" }] });
    expect(get).toHaveBeenCalledWith("/456", { fields: "id,account_id,subtype" });
    expect(post).toHaveBeenCalledWith("/456/users", { payload: { schema: ["EMAIL", "PHONE"], data: [["", hash("12025550100")]] } });
    expect(JSON.stringify(response)).not.toContain("do-not-expose");
    expect(JSON.stringify(response)).toContain("not matched users");
  });
  it.each([{ account_id: "999", subtype: "CUSTOM" }, { subtype: "CUSTOM" }, { account_id: "123", subtype: "LOOKALIKE" }])("refuses cross-account, unknown-owner and non-customer audiences", async audience => {
    vi.spyOn(metaApiClient, "get").mockResolvedValue(audience);
    const post = vi.spyOn(metaApiClient, "post");
    await expect(tool()({ ...base, dry_run: false, users: [{ email: "test@example.com" }] })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
  it("validates the entire batch before making any request", async () => {
    const get = vi.spyOn(metaApiClient, "get");
    await expect(tool()({ ...base, dry_run: false, users: [{ email: "test@example.com" }, { phone: "invalid-private-value" }] })).rejects.toThrow("Row 2");
    expect(get).not.toHaveBeenCalled();
  });
  it("does not report success when Meta fails or omits receipt confirmation", async () => {
    vi.spyOn(metaApiClient, "get").mockResolvedValue({ account_id: "123", subtype: "CUSTOM" });
    vi.spyOn(metaApiClient, "post").mockResolvedValue({});
    await expect(tool()({ ...base, dry_run: false, users: [{ email: "test@example.com" }] })).rejects.toThrow("outcome is unknown");
  });
});
