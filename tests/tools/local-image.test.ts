import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalImage, MAX_LOCAL_IMAGE_BYTES } from "../../src/utils/local-image.js";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

let root: string;
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meta-local-image-"));
  vi.stubEnv("META_LOCAL_MEDIA_ROOT", root);
  setupTestToken();
});
afterEach(async () => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("local JPEG upload", () => {
  it("preserves JPEG bytes and MIME type", async () => {
    const file = join(root, "generated.jpeg");
    await writeFile(file, jpeg);
    const result = await readLocalImage(file);
    expect(result.buffer).toEqual(jpeg);
    expect(result.contentType).toBe("image/jpeg");
  });
  it("requires explicit opt-in and an absolute path", async () => {
    await expect(readLocalImage("relative.jpg")).rejects.toThrow("absolute");
    vi.stubEnv("META_LOCAL_MEDIA_ROOT", "");
    await expect(readLocalImage(join(root, "x.jpg"))).rejects.toThrow("not enabled");
  });
  it("rejects symlink escape", async () => {
    const outside = await mkdtemp(join(tmpdir(), "meta-outside-image-"));
    try {
      await writeFile(join(outside, "private.jpg"), jpeg);
      const link = join(root, "link.jpg");
      await symlink(join(outside, "private.jpg"), link);
      await expect(readLocalImage(link)).rejects.toThrow("inside the configured media");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it("rejects renamed non-images and non-JPEG extensions", async () => {
    await writeFile(join(root, "private.jpg"), "private non-image text");
    await expect(readLocalImage(join(root, "private.jpg"))).rejects.toThrow("JPEG image");
    await writeFile(join(root, "image.png"), jpeg);
    await expect(readLocalImage(join(root, "image.png"))).rejects.toThrow("JPEG (.jpg/.jpeg) only");
  });
  it("rejects empty and oversized files", async () => {
    const file = join(root, "bad.jpg");
    await writeFile(file, "");
    await expect(readLocalImage(file)).rejects.toThrow("regular file");
    await writeFile(file, Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1));
    await expect(readLocalImage(file)).rejects.toThrow("8 MiB");
  });
  it("uploads local bytes without URL fetch, publishing, or activating ads", async () => {
    const file = join(root, "generated.jpg");
    await writeFile(file, jpeg);
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      images: { photo: { hash: "uploaded-hash", url: "https://example.com/meta.jpg" } },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = server._registeredTools.find(t => t.name === "ads_upload_ad_image")!.handler;
    const result = await handler({ account_id: "123456", local_image_path: file }) as {content: {text: string}[]};
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toContain("/act_123456/adimages");
    const uploaded = (options.body as FormData).get("filename") as File;
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(jpeg);
    expect(result.content[0].text).toContain("https://example.com/meta.jpg");
  });
  it("rejects missing or ambiguous sources before contacting Meta", async () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    vi.stubGlobal("fetch", vi.fn());
    const handler = server._registeredTools.find(t => t.name === "ads_upload_ad_image")!.handler;
    await expect(handler({ account_id: "123456" })).rejects.toThrow("exactly one");
    await expect(handler({ account_id: "123456", local_image_path: join(root,"x.jpg"), image_url: "https://example.com/x.jpg" })).rejects.toThrow("exactly one");
    expect(fetch).not.toHaveBeenCalled();
  });
});
