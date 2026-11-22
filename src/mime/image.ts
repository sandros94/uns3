import type { MimeTable } from "../types.ts";

/**
 * Raster and vector images, from the formats every browser shows to camera and editing formats.
 *
 * @example
 * ```ts
 * import { createContentTypeResolver } from "uns3/mime";
 * import { image } from "uns3/mime/image";
 *
 * const contentTypeResolver = createContentTypeResolver(image);
 * ```
 */
export const image: MimeTable = Object.freeze({
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/vnd.microsoft.icon",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  jxl: "image/jxl",
  jp2: "image/jp2",
  psd: "image/vnd.adobe.photoshop",
});

export default image;
