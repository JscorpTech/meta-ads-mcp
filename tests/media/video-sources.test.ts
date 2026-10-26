import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fbcdnExpiresAt,
  resolveMetaVideoSources,
  resolveMetaVideoSourcesWithInfo,
  resourceUriFor,
} from "../../src/media/video-sources.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

function fetchCalls(): string[] {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

const VIDEO = {
  id: "999",
  title: "Hook test",
  source: "https://video.xx.fbcdn.net/v.mp4?oe=69617495",
  picture: "https://scontent.xx.fbcdn.net/small.jpg",
  thumbnails: { data: [{ uri: "https://scontent.xx.fbcdn.net/big.jpg", width: 1080, height: 1920 }] },
  length: 15.2,
  permalink_url: "https://www.facebook.com/999",
  status: { video_status: "ready" },
};

describe("fbcdnExpiresAt", () => {
  it("decodes the hex oe parameter into an ISO timestamp", () => {
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oh=x&oe=69617495")).toBe("2026-01-09T21:35:17.000Z");
  });

  it("returns undefined for missing or implausible values", () => {
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4")).toBeUndefined();
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oe=zz")).toBeUndefined();
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oe=1")).toBeUndefined();
    expect(fbcdnExpiresAt(undefined)).toBeUndefined();
  });
});

describe("resourceUriFor", () => {
  it("builds stable uris for meta and ad library videos", () => {
    expect(resourceUriFor({ key: "k", label: "l", origin: "meta", video_id: "123" })).toBe("meta-ads://video/123");
    expect(resourceUriFor({ key: "k", label: "l", origin: "ad_library", ad_archive_id: "555", card_index: 2 })).toBe("meta-ads://ad-library/555/video/2");
  });
});

describe("resolveMetaVideoSources", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves a video_id through the Graph video endpoint including permalink_url", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(VIDEO)));

    const sources = await resolveMetaVideoSources({ video_id: "999" });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      key: "meta:video:999",
      origin: "meta",
      video_id: "999",
      source_url: VIDEO.source,
      thumbnail_url: "https://scontent.xx.fbcdn.net/big.jpg",
      duration_seconds: 15.2,
      permalink_url: "https://www.facebook.com/999",
      title: "Hook test",
    });
    expect(fetchCalls()[0]).toMatch(/\/999\?/);
    expect(fetchCalls()[0]).toMatch(/permalink_url/);
  });

  it("resolves every video referenced by a creative, capped at max_videos", async () => {
    const creative = {
      id: "7001",
      name: "Carousel",
      object_story_spec: {
        link_data: {
          child_attachments: [
            { video_id: "9101", picture: "https://scontent.xx.fbcdn.net/c1.jpg" },
            { video_id: "9102" },
            { video_id: "9103" },
          ],
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(creative))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9101" }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9102" })),
    );

    const { sources, truncated } = await resolveMetaVideoSourcesWithInfo({ creative_id: "7001", max_videos: 2 });

    expect(sources.map((s) => s.video_id)).toEqual(["9101", "9102"]);
    expect(truncated).toBe(1);
    expect(fetchCalls()).toHaveLength(3);
  });

  it("resolves an ad through its creative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "8001", account_id: "123", creative: { id: "7001" } }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { video_data: { video_id: "9109" } } }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9109" })),
    );

    const sources = await resolveMetaVideoSources({ ad_id: "8001" });
    expect(sources.map((s) => s.video_id)).toEqual(["9109"]);
    expect(sources[0].label).toContain("9109");
  });

  it("keeps a failed video lookup as a source with an error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { video_data: { video_id: "9109", image_url: "https://scontent.xx.fbcdn.net/t.jpg" } } }))
        .mockResolvedValueOnce(mockFetchResponse({ error: { message: "Unsupported get request", code: 100 } }, { status: 400 })),
    );

    const sources = await resolveMetaVideoSources({ creative_id: "7001" });
    expect(sources).toHaveLength(1);
    expect(sources[0].error).toMatch(/Unsupported get request/);
    expect(sources[0].source_url).toBeUndefined();
    expect(sources[0].thumbnail_url).toBe("https://scontent.xx.fbcdn.net/t.jpg");
  });

  it("rejects invalid ids before calling Graph", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(resolveMetaVideoSources({ video_id: "../etc" })).rejects.toThrow(/Invalid/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns no sources for a creative without videos", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "7001", image_url: "https://scontent.xx.fbcdn.net/i.jpg" })));
    expect(await resolveMetaVideoSources({ creative_id: "7001" })).toEqual([]);
  });
});

// An own-account ad that reuses a post (or an Instagram post) of another page:
// the creative names its video only at the top level, and Graph gives no
// `source` for a video another page owns. Fictional ids.
describe("resolveMetaVideoSources for an ad that reuses a post", () => {
  const PAGE_ID = "7101";
  const POST_CREATIVE = {
    id: "5101",
    name: "Reused post",
    video_id: "6101",
    object_type: "VIDEO",
    effective_object_story_id: `${PAGE_ID}_6101`,
    effective_instagram_media_id: "17900000000000001",
    source_instagram_media_id: "17900000000000002",
    instagram_user_id: "17800000000000009",
    thumbnail_url: "https://scontent.xx.fbcdn.net/post-thumb.jpg",
  };
  const PAGE_VIDEO = { id: "6101", length: 30, from: { id: PAGE_ID, name: "Some Page Name" } };
  const IG_VIDEO = {
    id: "17900000000000001",
    media_type: "VIDEO",
    media_url: "https://scontent.cdninstagram.com/o1/v/ig.mp4?oh=1&oe=69617495",
    thumbnail_url: "https://scontent.cdninstagram.com/ig-thumb.jpg",
    permalink: "https://www.instagram.com/p/ABC/",
  };

  beforeEach(() => setupTestToken());
  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function route(routes: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      const id = new URL(url).pathname.split("/").pop() as string;
      const body = routes[id];
      if (body === undefined || (body as { __fail?: boolean }).__fail) {
        return mockFetchResponse({ error: { message: "Unsupported get request", code: 100 } }, { status: 400 });
      }
      return mockFetchResponse(body);
    });
  }

  function igCalls(): string[] {
    return fetchCalls().filter((u) => /\/1790000000000000\d\?/.test(u));
  }

  it("reads the video a creative names only at the top level, and asks Graph for it", async () => {
    vi.stubGlobal("fetch", route({ "5101": POST_CREATIVE, "6101": { ...VIDEO, id: "6101" } }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources.map((s) => s.video_id)).toEqual(["6101"]);
    expect(sources[0].source_url).toBe(VIDEO.source);
    const creativeFields = new URL(fetchCalls()[0]).searchParams.get("fields") ?? "";
    expect(creativeFields.split(",")).toEqual(expect.arrayContaining(["video_id", "object_type", "effective_instagram_media_id", "source_instagram_media_id"]));
  });

  it("takes the file from the ad's Instagram post when Graph has no source for the video", async () => {
    vi.stubGlobal("fetch", route({ "5101": POST_CREATIVE, "6101": PAGE_VIDEO, "17900000000000001": IG_VIDEO }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ origin: "meta", video_id: "6101", source_url: IG_VIDEO.media_url });
    expect(sources[0].error).toBeUndefined();
    expect(sources[0].label).toMatch(/Instagram/);
    expect(igCalls()).toHaveLength(1);
    expect(new URL(igCalls()[0]).searchParams.get("fields")).toBe("media_type,media_url,thumbnail_url,permalink");
  });

  it("tries the source Instagram media when the effective one cannot be read", async () => {
    vi.stubGlobal("fetch", route({
      "5101": POST_CREATIVE,
      "6101": PAGE_VIDEO,
      "17900000000000001": { __fail: true },
      "17900000000000002": { ...IG_VIDEO, id: "17900000000000002" },
    }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources[0].source_url).toBe(IG_VIDEO.media_url);
    expect(igCalls()).toHaveLength(2);
  });

  it("names the owning page by id and the Ad Library route when Instagram has no file either", async () => {
    vi.stubGlobal("fetch", route({
      "5101": POST_CREATIVE,
      "6101": PAGE_VIDEO,
      "17900000000000001": { __fail: true },
      "17900000000000002": { id: "17900000000000002", media_type: "VIDEO" },
    }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources[0].source_url).toBeUndefined();
    const error = sources[0].error ?? "";
    expect(error).toContain(`page ${PAGE_ID}`);
    expect(error).toContain(`view_all_page_id=${PAGE_ID}`);
    expect(error).toMatch(/ads_library_scrape/);
    expect(error).toMatch(/ads_library_get_results/);
    expect(error).toMatch(/dataset_id \+ ad_archive_id/);
    expect(error).not.toContain("Some Page Name");
  });

  it("gives the same guidance for a video_id, and asks the video for its owner", async () => {
    vi.stubGlobal("fetch", route({ "6101": PAGE_VIDEO }));

    const [source] = await resolveMetaVideoSources({ video_id: "6101" });

    expect(source.error).toContain(`view_all_page_id=${PAGE_ID}`);
    expect(new URL(fetchCalls()[0]).searchParams.get("fields")).toContain("from{id}");
  });

  it("does not ask Instagram for a creative with several videos", async () => {
    vi.stubGlobal("fetch", route({
      "5101": { ...POST_CREATIVE, video_id: undefined, asset_feed_spec: { videos: [{ video_id: "6101" }, { video_id: "6102" }] } },
      "6101": PAGE_VIDEO,
      "6102": { ...PAGE_VIDEO, id: "6102" },
      "17900000000000001": IG_VIDEO,
    }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources.map((s) => s.source_url)).toEqual([undefined, undefined]);
    expect(igCalls()).toHaveLength(0);
  });

  it("does not ask Instagram when Graph already gives the video's source", async () => {
    vi.stubGlobal("fetch", route({ "5101": POST_CREATIVE, "6101": { ...VIDEO, id: "6101" }, "17900000000000001": IG_VIDEO }));

    await resolveMetaVideoSources({ creative_id: "5101" });

    expect(fetchCalls()).toHaveLength(2);
    expect(igCalls()).toHaveLength(0);
  });

  it("finds the video of an Instagram post creative that names no video id", async () => {
    const { video_id: _ignored, ...noVideoId } = POST_CREATIVE;
    vi.stubGlobal("fetch", route({ "5101": noVideoId, "17900000000000001": IG_VIDEO }));

    const sources = await resolveMetaVideoSources({ creative_id: "5101" });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ origin: "meta", source_url: IG_VIDEO.media_url });
    expect(sources[0].label).toMatch(/Instagram/);
  });

  it("leaves a photo creative without videos, and does not ask Instagram", async () => {
    vi.stubGlobal("fetch", route({
      "5101": { id: "5101", object_type: "PHOTO", image_url: "https://scontent.xx.fbcdn.net/i.jpg", effective_instagram_media_id: "17900000000000001" },
      "17900000000000001": IG_VIDEO,
    }));

    expect(await resolveMetaVideoSources({ creative_id: "5101" })).toEqual([]);
    expect(igCalls()).toHaveLength(0);
  });

  it("leaves a creative without videos when its Instagram post is not a video", async () => {
    const { video_id: _ignored, ...noVideoId } = POST_CREATIVE;
    vi.stubGlobal("fetch", route({ "5101": { ...noVideoId, object_type: "SHARE" }, "17900000000000001": { ...IG_VIDEO, media_type: "CAROUSEL_ALBUM" }, "17900000000000002": { __fail: true } }));

    expect(await resolveMetaVideoSources({ creative_id: "5101" })).toEqual([]);
  });
});
