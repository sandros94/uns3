import type { MimeTable } from "../types.ts";

/**
 * Web pages and their assets, the image, audio and video formats browsers
 * play, PDFs, and zip and gzip archives: 31 extensions. `S3Client` infers
 * from this group unless you pass a resolver of your own.
 *
 * @example
 * ```ts
 * import { common, createContentTypeResolver } from "uns3/mime";
 *
 * const contentTypeResolver = createContentTypeResolver(common, { heic: "image/heic" });
 * ```
 */
export const common: MimeTable = Object.freeze({
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
});

export default common;
