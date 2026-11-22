import type { MimeTable } from "../types.ts";

/**
 * The formats a website is made of: pages, styles, scripts, data, feeds and the manifest.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
 */
export const web: MimeTable = Object.freeze({
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  json5: "application/json5",
  jsonld: "application/ld+json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  xsl: "application/xml",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  txt: "text/plain",
  ico: "image/vnd.microsoft.icon",
  rss: "application/rss+xml",
  atom: "application/atom+xml",
  ics: "text/calendar",
  vcf: "text/vcard",
  vtt: "text/vtt",
  md: "text/markdown",
});

export default web;
