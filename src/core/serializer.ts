import type { BaseRequest, PutObjectParams } from "../types";
import { isReadableStream } from "../utils";

export interface HeaderBuildOptions {
  headers?: HeadersInit;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
}

/**
 * Builds a {@link Headers} object merging caller-supplied entries with
 * optional metadata fields commonly used by S3 operations.
 *
 * @param options - User supplied header bag plus standard metadata values.
 */
export function createHeaders(options: HeaderBuildOptions): Headers {
  const headers = new Headers(options.headers);
  if (options.contentType) {
    headers.set("content-type", options.contentType);
  }

  if (options.cacheControl) {
    headers.set("cache-control", options.cacheControl);
  }

  if (options.contentDisposition) {
    headers.set("content-disposition", options.contentDisposition);
  }

  if (options.contentEncoding) {
    headers.set("content-encoding", options.contentEncoding);
  }

  return headers;
}

/**
 * Applies query parameters to a URL while accepting common S3 value formats
 * (single values and arrays).
 *
 * @param url - URL instance to mutate.
 * @param query - Record of query parameters.
 */
export function applyQuery(url: URL, query: BaseRequest["query"]): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined) continue;
        url.searchParams.append(key, normalizeQueryValue(item));
      }
    } else {
      url.searchParams.append(key, normalizeQueryValue(value));
    }
  }
}

/**
 * Checks whether a PUT body should be treated as a stream (and therefore not
 * hashed by default).
 *
 * @param body - Supplied upload body.
 */
export function isPayloadStream(
  body: PutObjectParams["body"],
): body is ReadableStream<Uint8Array> {
  return isReadableStream(body);
}

// #region Internal

function normalizeQueryValue(value: string | number | boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value.toString() : "";
  return value ? "true" : "false";
}
