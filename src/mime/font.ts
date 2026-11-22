import type { MimeTable } from "../types.ts";

/**
 * Font files.
 *
 * @example
 * ```ts
 * import { createContentTypeResolver } from "uns3/mime";
 * import { font } from "uns3/mime/font";
 *
 * const contentTypeResolver = createContentTypeResolver(font);
 * ```
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
