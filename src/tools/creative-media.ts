import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { isMetaId, normalizeAccountId, validateMetaId } from "../utils/format.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import { IMAGE_DEFAULT_FIELDS } from "../meta/types/image.js";
import { VIDEO_DETAIL_FIELDS } from "../meta/types/video.js";
import type { AdCreative, AdImage, AdVideo, MetaApiResponse } from "../meta/types/index.js";
import { downloadSafePublicImage } from "../utils/safe-download.js";
import { resolveTenantId } from "../auth/tenant.js";
import { sanitizeMetadataUrl, textBlock, type ContentBlock } from "../media/content-blocks.js";
import {
  deliverVideos as defaultDeliverVideos,
  responseBytesBudget,
  VIDEO_EXPIRY_WARNING,
  type DeliveredVideo,
  type VideoDeliveryDeps,
} from "../media/video-delivery.js";
import type { VideoSource } from "../media/video-sources.js";
import { findInstagramVideoFile, FROM_INSTAGRAM, noVideoFileError, videoFileUrl, type InstagramVideoFile } from "../media/video-file-fallback.js";
import { fetchCreativeImageBlocks } from "../media/creative-images.js";
import { asRecord, getString } from "./creatives.js";
import { READ } from "./_register.js";

const TOTAL_BYTES_BUDGET = 20 * 1024 * 1024;
const MISSING_ACCOUNT_HINT =
  "Image hash could not be resolved to a URL — pass account_id so the adimages lookup can run.";

export type MediaRole =
  | "primary"
  | "carousel_child"
  | "asset_feed_image"
  | "video_thumbnail"
  | "thumbnail_fallback";

export interface ImageRef {
  role: MediaRole;
  url?: string;
  hash?: string;
  carouselIndex?: number;
}

export interface VideoRef {
  videoId: string;
  specThumbnailUrl?: string;
  specThumbnailHash?: string;
  /** The creative's thumbnail_fallback image is this video's poster. */
  posterIsFallback?: boolean;
}

interface ImageAssetMeta {
  block_index?: number;
  role: MediaRole;
  carousel_index?: number;
  image_hash?: string;
  width?: number;
  height?: number;
  permalink_url?: string;
  source_url?: string;
  mime_type?: string;
  bytes?: number;
  downloaded: boolean;
  error?: string;
  skipped?: "max_images" | "size_budget";
}

interface VideoAssetMeta {
  /** Absent for a video known only through the creative's Instagram post. */
  video_id?: string;
  instagram_media_id?: string;
  file_from?: "instagram";
  title?: string;
  length_seconds?: number;
  source_url?: string;
  thumbnail_url?: string;
  permalink_url?: string;
  thumbnail_block_index?: number;
  download_hint?: string;
  delivered?: DeliveredVideo["delivered"];
  error?: string;
}

function videoKey(video: VideoAssetMeta): string {
  return video.video_id ? `meta:video:${video.video_id}` : `meta:instagram:${video.instagram_media_id}`;
}

function videoName(video: VideoAssetMeta): string {
  const name = video.video_id ? `Video ${video.video_id}` : `Instagram video ${video.instagram_media_id}`;
  return video.file_from ? `${name} (${FROM_INSTAGRAM})` : name;
}

const downloadHint = (id: string): string =>
  `Download with: curl -L -o video_${id}.mp4 "<source_url>" — or pass the URL directly to a video-capable model (e.g. Gemini).`;

export function collectCreativeMedia(creative: AdCreative): { images: ImageRef[]; videos: VideoRef[] } {
  const images: ImageRef[] = [];
  const videos: VideoRef[] = [];
  const imagesByKey = new Map<string, ImageRef>();
  const seenVideos = new Set<string>();

  const addImage = (ref: ImageRef): void => {
    const keys = [ref.hash, ref.url].filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;
    // A ref carrying both identifiers can connect two previously separate
    // entries (one hash-only, one url-only) — merge them into one asset so the
    // same image is never downloaded twice.
    const existingRefs = [...new Set(keys.map((key) => imagesByKey.get(key)).filter((r): r is ImageRef => Boolean(r)))];
    if (existingRefs.length > 0) {
      const target = existingRefs[0];
      for (const other of existingRefs.slice(1)) {
        target.hash ??= other.hash;
        target.url ??= other.url;
        const index = images.indexOf(other);
        if (index >= 0) images.splice(index, 1);
        for (const [key, value] of imagesByKey) {
          if (value === other) imagesByKey.set(key, target);
        }
      }
      target.hash ??= ref.hash;
      target.url ??= ref.url;
      for (const key of keys) imagesByKey.set(key, target);
      return;
    }
    images.push(ref);
    for (const key of keys) imagesByKey.set(key, ref);
  };
  const addVideo = (ref: VideoRef): void => {
    if (seenVideos.has(ref.videoId)) return;
    seenVideos.add(ref.videoId);
    videos.push(ref);
  };

  addImage({ role: "primary", url: creative.image_url, hash: creative.image_hash });

  const objectStorySpec = asRecord(creative.object_story_spec);
  const linkData = asRecord(objectStorySpec?.["link_data"]);
  if (linkData) {
    addImage({
      role: "primary",
      hash: getString(linkData, "image_hash"),
      url: getString(linkData, "picture"),
    });
    const children = Array.isArray(linkData["child_attachments"]) ? linkData["child_attachments"] : [];
    children.forEach((child, index) => {
      const record = asRecord(child);
      if (!record) return;
      const videoId = getString(record, "video_id");
      if (videoId) {
        addVideo({
          videoId,
          specThumbnailUrl: getString(record, "picture"),
          specThumbnailHash: getString(record, "image_hash"),
        });
        return;
      }
      addImage({
        role: "carousel_child",
        carouselIndex: index,
        hash: getString(record, "image_hash"),
        url: getString(record, "picture"),
      });
    });
  }

  const videoData = asRecord(objectStorySpec?.["video_data"]);
  const videoId = getString(videoData, "video_id");
  if (videoId) {
    addVideo({
      videoId,
      specThumbnailUrl: getString(videoData, "image_url"),
      specThumbnailHash: getString(videoData, "image_hash"),
    });
  }

  const assetFeedSpec = asRecord(creative.asset_feed_spec);
  const feedImages = Array.isArray(assetFeedSpec?.["images"]) ? assetFeedSpec["images"] : [];
  for (const entry of feedImages) {
    const record = asRecord(entry);
    if (!record) continue;
    addImage({
      role: "asset_feed_image",
      hash: getString(record, "hash"),
      url: getString(record, "url"),
    });
  }
  const feedVideos = Array.isArray(assetFeedSpec?.["videos"]) ? assetFeedSpec["videos"] : [];
  for (const entry of feedVideos) {
    const record = asRecord(entry);
    const feedVideoId = getString(record, "video_id");
    if (!feedVideoId) continue;
    addVideo({
      videoId: feedVideoId,
      specThumbnailUrl: getString(record, "thumbnail_url"),
      specThumbnailHash: getString(record, "thumbnail_hash"),
    });
  }

  // Decided before the top-level video: a reused post keeps its enlarged
  // thumbnail, which then serves as that video's poster.
  const thumbnailFallback = images.length === 0 && videos.length === 0 && Boolean(creative.thumbnail_url);

  // An ad that reuses a post names its video only here. Last, so the
  // positions video_index addresses stay where they were.
  if (typeof creative.video_id === "string" && creative.video_id) {
    addVideo({ videoId: creative.video_id, specThumbnailUrl: creative.thumbnail_url, posterIsFallback: thumbnailFallback || undefined });
  }

  if (thumbnailFallback) {
    addImage({ role: "thumbnail_fallback", url: creative.thumbnail_url });
  }

  return { images, videos };
}

export function pickVideoThumbnailUrl(video: AdVideo, size: "full" | "small"): string | undefined {
  // Graph data is untrusted: an entry that is not a thumbnail with a uri is skipped, never read.
  const data: unknown = video.thumbnails?.data;
  const thumbs = (Array.isArray(data) ? data : []).filter(
    (t): t is { uri: string; width?: unknown } =>
      typeof t === "object" && t !== null && typeof (t as { uri?: unknown }).uri === "string",
  );
  const largest = thumbs.length > 0
    ? [...thumbs].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0]
    : undefined;
  const picture = typeof video.picture === "string" ? video.picture : undefined;
  return size === "small" ? picture ?? largest?.uri : largest?.uri ?? picture;
}

export async function resolveImageHashes(accountId: string, hashes: string[]): Promise<Map<string, AdImage>> {
  const response = await metaApiClient.get<MetaApiResponse<AdImage>>(
    `/${accountId}/adimages`,
    {
      fields: IMAGE_DEFAULT_FIELDS.join(","),
      hashes: JSON.stringify(hashes),
    },
  );
  return new Map((response.data ?? []).map((img) => [img.hash, img]));
}

export interface CreativeMediaDeps extends VideoDeliveryDeps {
  download?: typeof downloadSafePublicImage;
  deliverVideos?: typeof defaultDeliverVideos;
}

export function registerCreativeMediaTools(server: McpServer, deps: CreativeMediaDeps = {}): void {
  const download = deps.download ?? downloadSafePublicImage;
  const deliverVideos = deps.deliverVideos ?? defaultDeliverVideos;

  server.registerTool(
    "ads_get_creative_media",
    {
      description:
        "Download the actual creative media for an ad or creative and return the images inline for visual analysis. Images (including carousel cards and video thumbnails) come back as image content blocks a multimodal model can see directly. Videos: video_delivery=thumbnail (default) returns the poster frame plus a short-lived signed source URL in the JSON metadata; video_delivery=frames additionally extracts real keyframes with ffmpeg as image blocks so any multimodal model can analyze the video; video_delivery=url returns resource_link blocks. For the MP4 itself (video-capable models such as Gemini) use ads_get_video_media with delivery=inline.",
      inputSchema: {
        ad_id: z.string().optional().describe("Ad ID — its creative is resolved automatically"),
        creative_id: z.string().optional().describe("Creative ID (alternative to ad_id)"),
        account_id: z
          .string()
          .optional()
          .describe("Ad account ID (act_… or numeric). Only needed as a fallback when the creative references image hashes and the account cannot be derived from the ad/creative"),
        image_size: z
          .enum(["full", "small"])
          .default("full")
          .describe("full = original CDN image; small = 128px preview (url_128) when available — cheaper on context"),
        max_images: z
          .number()
          .min(1)
          .max(10)
          .default(5)
          .describe("Cap on returned image blocks (bounds response/context size)"),
        include_videos: z
          .boolean()
          .default(true)
          .describe("Also resolve videos: returns each video's thumbnail as an image block plus its signed source URL in the JSON metadata"),
        video_delivery: z
          .enum(["thumbnail", "frames", "url"])
          .default("thumbnail")
          .describe("thumbnail = poster image only (default); frames = also extract keyframes with ffmpeg (grid contact sheet); url = also return signed CDN links as resource_link blocks"),
        frame_count: z.number().int().min(1).max(12).default(6).describe("Frames per video when video_delivery=frames"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, creative_id, account_id, image_size = "full", max_images = 5, include_videos = true, video_delivery = "thumbnail", frame_count = 6 }, extra) => {
      if (!ad_id && !creative_id) {
        throw new Error("Either ad_id or creative_id is required.");
      }
      if (ad_id && creative_id) {
        throw new Error("Provide either ad_id or creative_id, not both.");
      }

      let resolvedAccountId = account_id ? normalizeAccountId(account_id) : undefined;
      let creativeId = creative_id;

      if (ad_id) {
        const adId = validateMetaId(ad_id, "ad");
        const ad = await metaApiClient.get<{ id: string; account_id?: string; creative?: { id: string } }>(
          `/${adId}`,
          { fields: "id,account_id,creative{id}" },
        );
        if (!ad.creative?.id) {
          throw new Error(`Ad ${adId} has no creative attached.`);
        }
        creativeId = ad.creative.id;
        if (!resolvedAccountId && ad.account_id) {
          resolvedAccountId = normalizeAccountId(ad.account_id);
        }
      }

      const id = validateMetaId(creativeId as string, "creative");
      // thumbnail_width/height make Graph return an upsized thumbnail_url, so the
      // boosted-post fallback yields an analyzable image instead of a 64px one.
      const creative = await metaApiClient.get<AdCreative>(`/${id}`, {
        fields: [...CREATIVE_DEFAULT_FIELDS, "account_id"].join(","),
        thumbnail_width: 1080,
        thumbnail_height: 1080,
      });
      if (!resolvedAccountId && creative.account_id) {
        resolvedAccountId = normalizeAccountId(creative.account_id);
      }

      const { images, videos } = collectCreativeMedia(creative);
      const warnings: string[] = [];

      // In "small" mode a hash is worth resolving even when the spec already
      // carries a full-size URL — the adimages lookup is what provides url_128.
      const wantSmall = image_size === "small";
      const hashesToResolve = new Set<string>();
      for (const ref of images) {
        if (ref.hash && (!ref.url || wantSmall)) hashesToResolve.add(ref.hash);
      }
      for (const ref of videos) {
        if (ref.specThumbnailHash && (!ref.specThumbnailUrl || wantSmall)) hashesToResolve.add(ref.specThumbnailHash);
      }

      let hashMap = new Map<string, AdImage>();
      if (hashesToResolve.size > 0) {
        if (resolvedAccountId) {
          try {
            hashMap = await resolveImageHashes(resolvedAccountId, [...hashesToResolve]);
          } catch (err) {
            warnings.push(`Image hash lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const blockedByMissingAccount =
            images.some((ref) => ref.hash && !ref.url)
            || videos.some((ref) => ref.specThumbnailHash && !ref.specThumbnailUrl);
          if (blockedByMissingAccount) warnings.push(MISSING_ACCOUNT_HINT);
        }
      }

      const resolvedHashUrl = (hash?: string): string | undefined => {
        if (!hash) return undefined;
        const resolved = hashMap.get(hash);
        return wantSmall ? resolved?.url_128 ?? resolved?.url : resolved?.url;
      };

      const imageAssets: ImageAssetMeta[] = images.map((ref) => {
        const resolved = ref.hash ? hashMap.get(ref.hash) : undefined;
        const fullUrl = resolved?.url ?? ref.url;
        const sourceUrl = image_size === "small" ? resolved?.url_128 ?? fullUrl : fullUrl;
        return {
          role: ref.role,
          carousel_index: ref.carouselIndex,
          image_hash: ref.hash,
          width: resolved?.width,
          height: resolved?.height,
          permalink_url: resolved?.permalink_url,
          source_url: sourceUrl,
          downloaded: false,
          error: sourceUrl ? undefined : (resolvedAccountId ? "No downloadable URL found for this image." : MISSING_ACCOUNT_HINT),
        };
      });

      const videoAssets: VideoAssetMeta[] = [];
      // Keyed by videoKey, so a video known only by its Instagram id has a poster too.
      const videoThumbAssets = new Map<string, ImageAssetMeta>();
      if (include_videos) {
        const fallbackPoster = imageAssets.find((asset) => asset.role === "thumbnail_fallback");
        // A reused post's enlarged thumbnail is its video's poster; otherwise the
        // video's own thumbnail, then the one the spec names.
        const posterOf = (ref: VideoRef | undefined, videoThumb?: string): ImageAssetMeta | undefined => {
          if ((!ref || ref.posterIsFallback) && fallbackPoster) return fallbackPoster;
          const url = videoThumb
            ?? (ref && (wantSmall ? resolvedHashUrl(ref.specThumbnailHash) ?? ref.specThumbnailUrl : ref.specThumbnailUrl ?? resolvedHashUrl(ref.specThumbnailHash)));
          if (!url) return undefined;
          const asset: ImageAssetMeta = { role: "video_thumbnail", source_url: url, downloaded: false };
          imageAssets.push(asset);
          return asset;
        };
        const pushVideo = (asset: VideoAssetMeta, poster: ImageAssetMeta | undefined): void => {
          videoAssets.push(asset);
          if (poster) videoThumbAssets.set(videoKey(asset), poster);
        };
        const instagramAsset = (file: InstagramVideoFile, poster: ImageAssetMeta | undefined): VideoAssetMeta => ({
          instagram_media_id: file.media_id,
          source_url: file.source_url,
          file_from: "instagram",
          thumbnail_url: poster?.source_url ?? file.thumbnail_url,
          permalink_url: file.permalink_url,
          download_hint: downloadHint(file.media_id),
        });
        for (const ref of videos) {
          // An id Graph would reject is never kept or reused: such a video is
          // reached, if at all, through the validated Instagram id. Its poster stays.
          if (!isMetaId(ref.videoId)) {
            const poster = posterOf(ref);
            const file = await findInstagramVideoFile(creative, videos.length);
            if (file) pushVideo(instagramAsset(file, poster), poster);
            else warnings.push("A video of this creative has a malformed id and was skipped.");
            continue;
          }
          try {
            const video = await metaApiClient.get<AdVideo>(
              `/${ref.videoId}`,
              { fields: VIDEO_DETAIL_FIELDS.join(",") },
            );
            const poster = posterOf(ref, pickVideoThumbnailUrl(video, image_size));
            const ownSource = videoFileUrl(video);
            const file = ownSource ? undefined : await findInstagramVideoFile(creative, videos.length);
            const sourceUrl = ownSource ?? file?.source_url;
            pushVideo({
              video_id: video.id,
              title: video.title,
              length_seconds: video.length,
              source_url: sourceUrl,
              file_from: file ? "instagram" : undefined,
              thumbnail_url: poster?.source_url,
              permalink_url: video.permalink_url ?? file?.permalink_url,
              download_hint: sourceUrl ? downloadHint(video.id) : undefined,
              error: sourceUrl ? undefined : noVideoFileError(video),
            }, poster);
          } catch (err) {
            const poster = posterOf(ref);
            const file = await findInstagramVideoFile(creative, videos.length);
            pushVideo({
              video_id: ref.videoId,
              source_url: file?.source_url,
              file_from: file ? "instagram" : undefined,
              permalink_url: file?.permalink_url,
              download_hint: file ? downloadHint(ref.videoId) : undefined,
              error: file ? undefined : err instanceof Error ? err.message : String(err),
            }, poster);
          }
        }
        if (videos.length === 0) {
          const file = await findInstagramVideoFile(creative, 0);
          if (file) {
            const poster = posterOf(undefined, undefined);
            pushVideo(instagramAsset(file, poster), poster);
          }
        }
      }

      // Shared with the dossier so both attach images under the same caps.
      // Over stdio the whole result must fit the SDK's message limit, so the
      // image budget is bounded by the response budget as well.
      const responseBudget = responseBytesBudget(deps.transport);
      const imageResult = await fetchCreativeImageBlocks(imageAssets, {
        maxImages: max_images,
        totalBytesBudget: Math.min(TOTAL_BYTES_BUDGET, responseBudget),
        signal: extra?.signal,
        download,
      });
      const imageBlocks = imageResult.blocks;
      const totalBytes = imageResult.bytes;

      for (const video of videoAssets) {
        const thumbAsset = videoThumbAssets.get(videoKey(video));
        if (thumbAsset?.downloaded) video.thumbnail_block_index = thumbAsset.block_index;
      }

      const videoBlocks: ContentBlock[] = [];
      const deliverySummary: string[] = [];
      if (video_delivery !== "thumbnail" && videoAssets.some((v) => v.source_url)) {
        const sources: VideoSource[] = videoAssets
          .filter((v) => v.source_url)
          .map((v) => ({
            key: videoKey(v),
            label: videoName(v),
            origin: "meta",
            video_id: v.video_id,
            source_url: v.source_url,
            // The poster is already attached above; the pipeline must not fetch it twice.
            thumbnail_url: undefined,
            duration_seconds: v.length_seconds,
            permalink_url: v.permalink_url,
            title: v.title,
          }));
        // Images already attached count against the same response budget as the video media.
        const remainingBudget = Math.max(0, responseBudget - totalBytes);
        const delivery = await deliverVideos(
          sources,
          { delivery: video_delivery, frame_count, frame_layout: "grid" },
          deps,
          { tenantId: resolveTenantId({ feature: "video" }), signal: extra?.signal },
          { totalBytesBudget: remainingBudget },
        );
        // Video blocks are appended after the image blocks (and after the summary text at index 0).
        const offset = imageBlocks.length + 1;
        videoBlocks.push(...delivery.blocks);
        for (const delivered of delivery.videos) {
          const asset = videoAssets.find((v) => videoKey(v) === delivered.key);
          if (!asset) continue;
          asset.delivered = {
            ...delivered.delivered,
            block_indexes: delivered.delivered.block_indexes.map((i) => i + offset),
          };
          if (delivered.error && !asset.error) asset.error = delivered.error;
          if (delivered.delivered.mode === "frames") {
            const ts = (delivered.delivered.frame_timestamps ?? []).map((t) => `${t.toFixed(1)}s`).join(", ");
            deliverySummary.push(`${videoName(asset)}: keyframes attached as block(s) ${asset.delivered.block_indexes.join(", ")} (contact sheet, read left-to-right, top-to-bottom; sampled at ${ts}).`);
          } else if (delivered.delivered.mode === "url") {
            deliverySummary.push(`${videoName(asset)}: signed URL(s) attached as resource_link block(s) ${asset.delivered.block_indexes.join(", ")}.`);
          } else if (delivered.error) {
            deliverySummary.push(`${videoName(asset)}: ${delivered.error}`);
          }
        }
        warnings.push(...delivery.warnings.filter((w) => w !== VIDEO_EXPIRY_WARNING));
      }

      if (videoAssets.some((v) => v.source_url)) {
        warnings.push(VIDEO_EXPIRY_WARNING);
      }

      const downloadedCount = imageAssets.filter((a) => a.downloaded).length;
      const failedCount = imageAssets.filter((a) => !a.downloaded && a.error).length;
      const skippedCount = imageAssets.filter((a) => a.skipped).length;

      const summaryLines: string[] = [];
      if (downloadedCount === 0 && videoAssets.length === 0) {
        summaryLines.push(`No downloadable media found for creative ${creative.id}.`);
      } else {
        summaryLines.push(
          `Creative ${creative.id} (${creative.name ?? "Unnamed"}): ${downloadedCount} image(s) attached below${failedCount ? `, ${failedCount} failed` : ""}${skippedCount ? `, ${skippedCount} skipped (limits)` : ""}.`,
        );
        const roles = imageAssets
          .filter((a) => a.downloaded)
          .map((a) => a.role + (a.carousel_index !== undefined ? `#${a.carousel_index}` : ""));
        if (roles.length > 0) summaryLines.push(`Image roles, in block order: ${roles.join(", ")}.`);
        for (const video of videoAssets) {
          summaryLines.push(
            video.source_url
              ? `${videoName(video)}${video.length_seconds ? ` (${video.length_seconds}s)` : ""}: ${video_delivery === "thumbnail" ? "thumbnail attached; " : ""}signed source_url in the JSON metadata (curl -L -o video_${video.video_id ?? video.instagram_media_id}.mp4 "<source_url>"), or call ads_get_video_media (delivery=frames for keyframes, delivery=inline to embed the MP4 for a video-capable model).`
              : `${videoName(video)}: ${video.error ?? "no source URL available."}`,
          );
        }
        summaryLines.push(...deliverySummary);
      }
      if (warnings.length > 0) {
        summaryLines.push(...warnings.map((w) => `⚠ ${w}`));
      }

      const metadata = {
        creative_id: creative.id,
        ad_id: ad_id ?? undefined,
        account_id: resolvedAccountId,
        images: imageAssets.map((asset) => ({
          ...asset,
          source_url: sanitizeMetadataUrl(asset.source_url),
          permalink_url: sanitizeMetadataUrl(asset.permalink_url),
        })),
        videos: videoAssets.map((video) => ({
          ...video,
          source_url: sanitizeMetadataUrl(video.source_url),
          thumbnail_url: sanitizeMetadataUrl(video.thumbnail_url),
          permalink_url: sanitizeMetadataUrl(video.permalink_url),
        })),
        video_delivery,
        warnings,
      };

      return {
        content: [
          textBlock(summaryLines.join("\n")),
          ...imageBlocks,
          ...videoBlocks,
          textBlock(JSON.stringify(metadata, null, 2)),
        ],
      };
    },
  );
}
