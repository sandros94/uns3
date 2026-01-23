import type { ContentTypeResolver } from "../types.ts";
import { lookup } from "../utils/mime.ts";

/**
 * Default resolver that infers a content type for a key using explicit
 * overrides first, then falls back to the internal MIME table.
 *
 * @param key - Object key whose extension drives detection.
 * @param explicit - Optional override supplied by the caller.
 */
export const defaultContentTypeResolver: ContentTypeResolver = (
  key,
  explicit,
) => {
  if (explicit === false) {
    return undefined;
  }

  if (typeof explicit === "string" && explicit.trim()) {
    return explicit;
  }

  const inferred = lookupExtension(key);
  if (inferred) {
    return inferred;
  }

  if (typeof explicit === "string") {
    return explicit;
  }

  return undefined;
};

/**
 * Resolves a content type using the provided resolver or the default logic.
 *
 * @param key - Object key used for heuristic lookup.
 * @param explicit - Optional override supplied by the caller.
 * @param resolver - Custom resolver to use instead of the default.
 */
export function resolveContentType(
  key: string,
  explicit: string | false | undefined,
  resolver?: ContentTypeResolver,
): string | undefined {
  const fn = resolver ?? defaultContentTypeResolver;
  return fn(key, explicit);
}

// #region Internal

function lookupExtension(key: string): string | undefined {
  const questionIndex = key.indexOf("?");
  const hashIndex = key.indexOf("#");
  let end = key.length;
  if (questionIndex !== -1) {
    end = Math.min(end, questionIndex);
  }
  if (hashIndex !== -1) {
    end = Math.min(end, hashIndex);
  }
  const normalized = key.slice(0, end);
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) {
    return undefined;
  }
  const ext = normalized.slice(lastDot + 1);
  return lookup(ext);
}
