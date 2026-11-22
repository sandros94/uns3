import type { MimeTable } from "../types.ts";

/**
 * Archives and compressed files.
 *
 * @example
 * ```ts
 * import { createContentTypeResolver } from "uns3/mime";
 * import { archive } from "uns3/mime/archive";
 *
 * const contentTypeResolver = createContentTypeResolver(archive);
 * ```
 */
export const archive: MimeTable = Object.freeze({
  "zip": "application/zip",
  "gz": "application/gzip",
  "tgz": "application/gzip",
  "tar": "application/x-tar",
  "bz2": "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  "rar": "application/vnd.rar",
  "xz": "application/x-xz",
  "zst": "application/zstd",
});

export default archive;
