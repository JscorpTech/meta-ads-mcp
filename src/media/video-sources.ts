import { metaApiClient } from "../meta/client.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import type { AdCreative, AdVideo } from "../meta/types/index.js";
import { VIDEO_DETAIL_FIELDS } from "../meta/types/video.js";
import { validateMetaId } from "../utils/format.js";
import { collectCreativeMedia, pickVideoThumbnailUrl } from "../tools/creative-media.js";
import { findInstagramVideoFile, FROM_INSTAGRAM, instagramOnlySource, noVideoFileError, videoFileUrl, type InstagramVideoFile } from "./video-file-fallback.js";

export type VideoOrigin = "meta" | "ad_library";

export interface VideoSource {
  /** Stable identity used for caching and resource URIs, e.g. `meta:video:123`. */
  key: string;
  label: string;
  origin: VideoOrigin;
  video_id?: string;
  ad_archive_id?: string;
  card_index?: number;
  source_url?: string;
  /** Lower-bitrate rendition (Ad Library SD); preferred for download when present. */
  low_res_url?: string;
  thumbnail_url?: string;
  duration_seconds?: number;
  permalink_url?: string;
  title?: string;
  error?: string;
}

/**
 * fbcdn signed URLs carry their expiry as `oe=<hex unix seconds>`; surfacing it
 * lets an agent know whether a cached URL is still worth fetching.
 */
export function fbcdnExpiresAt(url: string | undefined): string | undefined {
  // URL parsing materializes every query parameter; a signed CDN url is never
  // anywhere near this long, so an oversized one is not worth decoding.
  if (!url || url.length > 4096) return undefined;
  try {
    const oe = new URL(url).searchParams.get("oe");
    if (!oe || !/^[0-9a-f]{6,10}$/i.test(oe)) return undefined;
    const seconds = Number.parseInt(oe, 16);
    if (!Number.isFinite(seconds) || seconds < 1_000_000_000 || seconds > 4_000_000_000) return undefined;
    return new Date(seconds * 1000).toISOString();
  } catch {
    return undefined;
  }
}

export function resourceUriFor(source: VideoSource): string {
  if (source.origin === "ad_library" && source.ad_archive_id) {
    return `meta-ads://ad-library/${source.ad_archive_id}/video/${source.card_index ?? 0}`;
  }
  return `meta-ads://video/${source.video_id ?? encodeURIComponent(source.key)}`;
}

export interface MetaVideoSourceInput {
  video_id?: string;
  ad_id?: string;
  creative_id?: string;
  max_videos?: number;
  /** Resolve only the video at this position in the creative (0-based); one Graph call instead of one per video. */
  video_index?: number;
}

export interface MetaVideoSourcesInfo {
  sources: VideoSource[];
  /** Videos referenced by the creative but not resolved because of max_videos. */
  truncated: number;
  creative_id?: string;
  account_id?: string;
}

const DEFAULT_MAX_VIDEOS = 3;

function withInstagramFile(source: VideoSource, file: InstagramVideoFile): VideoSource {
  return {
    ...source,
    label: `${source.label} (${FROM_INSTAGRAM})`,
    source_url: file.source_url,
    thumbnail_url: source.thumbnail_url ?? file.thumbnail_url,
    permalink_url: source.permalink_url ?? file.permalink_url,
    error: undefined,
  };
}

function sourceFromVideo(video: AdVideo, fallbackThumbnail?: string): VideoSource {
  const sourceUrl = videoFileUrl(video);
  return {
    key: `meta:video:${video.id}`,
    label: `Video ${video.id}${video.title ? ` "${video.title}"` : ""}`,
    origin: "meta",
    video_id: video.id,
    source_url: sourceUrl,
    thumbnail_url: pickVideoThumbnailUrl(video, "full") ?? fallbackThumbnail,
    duration_seconds: video.length,
    permalink_url: video.permalink_url,
    title: video.title,
    error: sourceUrl ? undefined : noVideoFileError(video),
  };
}

async function fetchVideo(videoId: string, fallbackThumbnail?: string): Promise<VideoSource> {
  const id = validateMetaId(videoId, "video");
  try {
    const video = await metaApiClient.get<AdVideo>(`/${id}`, { fields: VIDEO_DETAIL_FIELDS.join(",") });
    return sourceFromVideo(video, fallbackThumbnail);
  } catch (err) {
    return {
      key: `meta:video:${id}`,
      label: `Video ${id}`,
      origin: "meta",
      video_id: id,
      thumbnail_url: fallbackThumbnail,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolves the Meta-side origins a video tool accepts (`video_id`, `ad_id`,
 * `creative_id`) into downloadable sources. Exactly one id must be given.
 */
export async function resolveMetaVideoSourcesWithInfo(input: MetaVideoSourceInput): Promise<MetaVideoSourcesInfo> {
  const maxVideos = Math.max(1, input.max_videos ?? DEFAULT_MAX_VIDEOS);

  if (input.video_id) {
    return { sources: [await fetchVideo(input.video_id)], truncated: 0 };
  }

  let creativeId = input.creative_id;
  let accountId: string | undefined;
  if (input.ad_id) {
    const adId = validateMetaId(input.ad_id, "ad");
    const ad = await metaApiClient.get<{ id: string; account_id?: string; creative?: { id: string } }>(
      `/${adId}`,
      { fields: "id,account_id,creative{id}" },
    );
    if (!ad.creative?.id) {
      throw new Error(`Ad ${adId} has no creative attached.`);
    }
    creativeId = ad.creative.id;
    accountId = ad.account_id;
  }
  if (!creativeId) {
    throw new Error("One of video_id, ad_id or creative_id is required.");
  }

  const id = validateMetaId(creativeId, "creative");
  const creative = await metaApiClient.get<AdCreative>(`/${id}`, {
    fields: [...CREATIVE_DEFAULT_FIELDS, "account_id"].join(","),
    thumbnail_width: 1080,
    thumbnail_height: 1080,
  });
  const { videos } = collectCreativeMedia(creative);
  const info = (sources: VideoSource[], truncated: number): MetaVideoSourcesInfo => ({
    sources,
    truncated,
    creative_id: creative.id,
    account_id: accountId ?? creative.account_id,
  });
  if (videos.length === 0) {
    const file = await findInstagramVideoFile(creative, 0);
    const sources = file ? [instagramOnlySource(file)] : [];
    if (input.video_index !== undefined && !sources[input.video_index]) {
      throw new Error("video_index " + input.video_index + " is out of range: this creative has " + sources.length + " addressable video(s).");
    }
    return info(sources, 0);
  }
  const resolveOne = async (ref: (typeof videos)[number]): Promise<VideoSource> => {
    const source = await fetchVideo(ref.videoId, ref.specThumbnailUrl);
    if (source.source_url) return source;
    const file = await findInstagramVideoFile(creative, videos.length);
    return file ? withInstagramFile(source, file) : source;
  };
  if (input.video_index !== undefined) {
    const ref = videos[input.video_index];
    if (!ref) {
      throw new Error("video_index " + input.video_index + " is out of range: this creative has " + videos.length + " addressable video(s).");
    }
    return info([await resolveOne(ref)], 0);
  }
  const selected = videos.slice(0, maxVideos);
  const sources: VideoSource[] = [];
  for (const ref of selected) {
    sources.push(await resolveOne(ref));
  }
  return info(sources, videos.length - selected.length);
}

export async function resolveMetaVideoSources(input: MetaVideoSourceInput): Promise<VideoSource[]> {
  return (await resolveMetaVideoSourcesWithInfo(input)).sources;
}
