import type { MimeTable } from "../types.ts";

/**
 * Archives and compressed files.
 *
 * Pass it to `createContentTypeResolver` from `uns3/mime`, alone or with other groups.
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
