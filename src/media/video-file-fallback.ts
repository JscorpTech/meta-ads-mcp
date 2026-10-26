import { metaApiClient } from "../meta/client.js";
import type { AdCreative, AdVideo } from "../meta/types/index.js";
import { validateMetaId } from "../utils/format.js";
import type { VideoSource } from "./video-sources.js";

/**
 * Why Graph gave no file for a video, and what to do next. The owning page is
 * named by id only: its name is third-party text.
 */
export function noVideoFileError(video: AdVideo): string {
  const pageId = video.from?.id;
  if (typeof pageId !== "string" || !/^\d{1,30}$/.test(pageId)) {
    return "Video source URL not available (still processing, or owned by another page).";
  }
  return `Meta gives no file for this video: it belongs to page ${pageId}. The same ad is public in the Ad Library: ` +
    `run ads_library_scrape with url=https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=${pageId}&search_type=page&media_type=video ` +
    "and a small count such as 50 (about US$0.75 per 1,000 ads), find the ad by its text in ads_library_get_results, " +
    "then call ads_get_video_media or ads_analyze_video with its dataset_id + ad_archive_id.";
}

/** The video's own file: a `source` Graph sent as a non-empty string, or nothing. */
export function videoFileUrl(video: AdVideo | null | undefined): string | undefined {
  return typeof video?.source === "string" && video.source.length > 0 ? video.source : undefined;
}

export interface InstagramVideoFile {
  media_id: string;
  source_url: string;
  thumbnail_url?: string;
  permalink_url?: string;
}

/** Said in a label wherever the file came from Instagram rather than from the video itself. */
export const FROM_INSTAGRAM = "file from the ad's Instagram post";

/**
 * Graph gives no `source` for a video another page owns (an ad that reuses a
 * post), but the ad's Instagram post serves a playable MP4 in `media_url`.
 * `videoCount` is how many videos the creative resolves to. Never throws: a
 * failed lookup leaves the caller's own error in place.
 */
export async function findInstagramVideoFile(creative: AdCreative, videoCount: number): Promise<InstagramVideoFile | undefined> {
  // shortcut: a creative with several videos gets no fallback, since nothing says which one the Instagram post is; upgrade if Meta exposes that mapping.
  if (videoCount > 1) return undefined;
  if (videoCount === 0 && creative.object_type === "PHOTO") return undefined;
  const ids = [...new Set([creative.effective_instagram_media_id, creative.source_instagram_media_id])]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const mediaId of ids) {
    try {
      const media = await metaApiClient.get<Record<string, unknown>>(`/${validateMetaId(mediaId, "Instagram media")}`, {
        fields: "media_type,media_url,thumbnail_url,permalink",
      });
      if (media.media_type !== "VIDEO" || typeof media.media_url !== "string" || !media.media_url) continue;
      return {
        media_id: mediaId,
        source_url: media.media_url,
        thumbnail_url: typeof media.thumbnail_url === "string" ? media.thumbnail_url : undefined,
        permalink_url: typeof media.permalink === "string" ? media.permalink : undefined,
      };
    } catch {
      // Try the next id; with none left the caller keeps its own error.
    }
  }
  return undefined;
}

/** A creative that names no video id, but whose Instagram post is a video. */
export function instagramOnlySource(file: InstagramVideoFile): VideoSource {
  return {
    key: `meta:instagram:${file.media_id}`,
    label: `Instagram video ${file.media_id} (${FROM_INSTAGRAM})`,
    origin: "meta",
    source_url: file.source_url,
    thumbnail_url: file.thumbnail_url,
    permalink_url: file.permalink_url,
  };
}
