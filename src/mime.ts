import type { ContentTypeResolver, MimeTable } from "./types.ts";

export { default as common } from "./mime/common.ts";

/** A media type as RFC 6838 names it, optionally followed by parameters. */
const MEDIA_TYPE = /^[a-z0-9][\w!#$&^.+-]*\/[a-z0-9][\w!#$&^.+-]*(?:\s*;.*)?$/i;

/**
 * Builds a content type resolver for `S3Client`'s `contentTypeResolver` from
 * the tables you pass. Import only the groups you need, and the bundle holds
 * only those tables. A later table wins over an earlier one, and a record of
 * your own works like any group.
 *
 * The resolver keeps an explicit type, sets none for `false`, and otherwise
 * looks up the key's last extension, in any case.
 *
 * Groups use each format's IANA-registered type. Where none is registered, or
 * clients only recognize another, they use the type browsers and tools agree
 * on, such as `audio/wav`, `video/webm` or `application/x-tar`.
 *
 * @param tables - Groups from `uns3/mime/*`, or records of extension to type.
 * @returns A resolver to pass as `contentTypeResolver`.
 * @throws {TypeError} When an entry is not a media type.
 * @example
 * ```ts
 * import { S3Client } from "uns3";
 * import { createContentTypeResolver } from "uns3/mime";
 * import { image } from "uns3/mime/image";
 * import { video } from "uns3/mime/video";
 *
 * const client = new S3Client({
 *   endpoint,
 *   contentTypeResolver: createContentTypeResolver(image, video, { heic: "image/heic" }),
 * });
 * ```
 */
export function createContentTypeResolver(...tables: MimeTable[]): ContentTypeResolver {
  const types: Record<string, string> = Object.create(null);
  for (const table of tables) {
    for (const [extension, type] of Object.entries(table)) {
      if (typeof type !== "string" || !MEDIA_TYPE.test(type)) {
        throw new TypeError(`${JSON.stringify(type)} for "${extension}" is not a media type.`);
      }
      types[extension.replace(/^\./, "").toLowerCase()] = type;
    }
  }

  return (key, explicit) => {
    if (explicit === false) return undefined;
    if (typeof explicit === "string" && explicit.trim()) return explicit;
    const dot = key.lastIndexOf(".");
    return dot === -1 ? undefined : types[key.slice(dot + 1).toLowerCase()];
  };
}
