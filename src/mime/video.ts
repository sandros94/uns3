import type { MimeTable } from "../types.ts";

/**
 * Video files, and the playlists and segments of adaptive streaming. `ts` is an MPEG transport stream segment here, not TypeScript.
 *
 * @example
 * ```ts
 * import { createContentTypeResolver } from "uns3/mime";
 * import { video } from "uns3/mime/video";
 *
 * const contentTypeResolver = createContentTypeResolver(video);
 * ```
 */
export const video: MimeTable = Object.freeze({
  "mp4": "video/mp4",
  "m4v": "video/mp4",
  "webm": "video/webm",
  "mov": "video/quicktime",
  "qt": "video/quicktime",
  "mkv": "video/matroska",
  "avi": "video/x-msvideo",
  "ogv": "video/ogg",
  "mpeg": "video/mpeg",
  "mpg": "video/mpeg",
  "3gp": "video/3gpp",
  "ts": "video/mp2t",
  "m4s": "video/iso.segment",
  "m3u8": "application/vnd.apple.mpegurl",
  "mpd": "application/dash+xml",
});

export default video;
