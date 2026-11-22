import type { MimeTable } from "../types.ts";

/**
 * Font files.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
 */
export const font: MimeTable = Object.freeze({
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  ttc: "font/collection",
  eot: "application/vnd.ms-fontobject",
});

export default font;
