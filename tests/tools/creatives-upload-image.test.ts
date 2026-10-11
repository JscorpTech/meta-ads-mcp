import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/safe-download.js", () => ({
  downloadSafePublicImage: vi.fn(),
}));

import { adImageFileName, registerCreativeTools } from "../../src/tools/creatives.js";
import { downloadSafePublicImage } from "../../src/utils/safe-download.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
} from "../setup.js";

describe("adImageFileName", () => {
  it("falls back to image<ext> when there is no name", () => {
    expect(adImageFileName(undefined, ".png")).toBe("image.png");
    expect(adImageFileName("", ".png")).toBe("image.png");
  });

  it("appends the real extension to a bare name", () => {
    expect(adImageFileName("banner verano", ".png")).toBe("banner verano.png");
  });

  it("keeps a name that already ends with the real extension, case-insensitively", () => {
    expect(adImageFileName("Banner.PNG", ".png")).toBe("Banner.PNG");
  });

  it("treats .jpg and .jpeg as the same extension", () => {
    expect(adImageFileName("foto.jpeg", ".jpg")).toBe("foto.jpeg");
    expect(adImageFileName("foto.JPG", ".jpg")).toBe("foto.JPG");
  });

  it("replaces another known image extension with the real one", () => {
    expect(adImageFileName("foto.png", ".jpg")).toBe("foto.jpg");
    expect(adImageFileName("foto.WEBP", ".png")).toBe("foto.png");
    expect(adImageFileName("scan.tiff", ".jpg")).toBe("scan.jpg");
  });

  it("appends the real extension after an unknown one", () => {
    expect(adImageFileName("report.v2", ".png")).toBe("report.v2.png");
  });

  it("keeps only the last path segment", () => {
    expect(adImageFileName("../../etc/passwd", ".png")).toBe("passwd.png");
    expect(adImageFileName("a/b\\c.png", ".png")).toBe("c.png");
  });

  it("removes quotes, control characters and reserved characters, and collapses whitespace", () => {
    expect(adImageFileName('ban"ner\nve\trano <1>: a|b?c*d', ".png")).toBe("banner ve rano 1 abcd.png");
  });

  it("removes C1 control characters too", () => {
    expect(adImageFileName("a\u0085b\u009fc\u0080", ".png")).toBe("abc.png");
  });

  it("a name cut at the limit never splits a character", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const result = adImageFileName("x".repeat(95) + "😀", ".png");
    expect(result).not.toMatch(lone);
    expect(result).not.toContain("�");
    expect(result.endsWith(".png")).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(100);

    const longer = adImageFileName("x".repeat(94) + "😀😀😀", ".png");
    expect(longer).not.toMatch(lone);
    expect(longer.endsWith(".png")).toBe(true);
    expect(Array.from(longer).length).toBeLessThanOrEqual(100);
  });

  it("falls back to image<ext> when nothing is left after cleaning", () => {
    expect(adImageFileName("... ..", ".png")).toBe("image.png");
    expect(adImageFileName("   ", ".jpg")).toBe("image.jpg");
    expect(adImageFileName('"<>:|?*', ".png")).toBe("image.png");
  });

  it("drops leading dots", () => {
    expect(adImageFileName("..hidden", ".png")).toBe("hidden.png");
  });

  it("caps the result at 100 characters and keeps the extension", () => {
    const result = adImageFileName("x".repeat(300), ".png");
    expect(result).toHaveLength(100);
    expect(result.endsWith(".png")).toBe(true);
    expect(result).toBe("x".repeat(96) + ".png");
  });

  it("caps a long name that already carries the real extension", () => {
    const result = adImageFileName(`${"y".repeat(300)}.PNG`, ".png");
    expect(result).toHaveLength(100);
    expect(result.endsWith(".PNG")).toBe(true);
  });
});

describe("ads_upload_ad_image handler", () => {
  beforeEach(() => {
    setupTestToken();
    vi.mocked(downloadSafePublicImage).mockResolvedValue({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
      extension: ".png",
      finalUrl: new URL("https://cdn.example.com/a.png"),
    });
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  async function upload(args: { name?: string }): Promise<FormData> {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({ images: { x: { hash: "h1", url: "https://u", name: "n" } } }),
      ),
    );
    const handler = server._registeredTools.find((t) => t.name === "ads_upload_ad_image")!.handler;
    await handler({ account_id: "123", image_url: "https://cdn.example.com/a.png", ...args });
    const init = vi.mocked(fetch).mock.calls[0][1] as { body: FormData };
    return init.body;
  }

  it("names the multipart file after the caller's name", async () => {
    const form = await upload({ name: "promo-octubre" });
    const part = form.get("filename") as File;
    expect(part.name).toBe("promo-octubre.png");
    expect(form.get("name")).toBe("promo-octubre");
  });

  it("keeps image.png when no name is given", async () => {
    const form = await upload({});
    expect((form.get("filename") as File).name).toBe("image.png");
    expect(form.has("name")).toBe(false);
  });
});
