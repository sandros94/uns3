import type { MimeTable } from "../types.ts";

/**
 * The types most objects in a bucket are: web pages and their assets, common
 * images, audio and video, PDFs and archives. What `S3Client` infers from a key
 * unless given a resolver of its own.
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
