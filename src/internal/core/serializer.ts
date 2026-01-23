import type { BaseRequest, ByteRange, PutObjectParams } from "../../types.ts";
import { isReadableStream } from "../utils/is.ts";

export interface HeaderBuildOptions {
  headers?: HeadersInit;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  range?: ByteRange;
  ifMatch?: string | string[];
  ifNoneMatch?: string | string[];
  ifModifiedSince?: Date | string;
  ifUnmodifiedSince?: Date | string;
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

  const rangeValue = formatRange(options.range);
  if (rangeValue) {
    headers.set("range", rangeValue);
  }

  setMultiValueHeader(headers, "if-match", options.ifMatch);
  setMultiValueHeader(headers, "if-none-match", options.ifNoneMatch);

  const ifModifiedSince = formatHttpDate(options.ifModifiedSince);
  if (ifModifiedSince) {
    headers.set("if-modified-since", ifModifiedSince);
  }

  const ifUnmodifiedSince = formatHttpDate(options.ifUnmodifiedSince);
  if (ifUnmodifiedSince) {
    headers.set("if-unmodified-since", ifUnmodifiedSince);
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

function formatRange(range: ByteRange | undefined): string | undefined {
  if (!range) return undefined;
  const start = normalizeRangeBoundary(range.start, "start");
  const end = normalizeRangeBoundary(range.end, "end");
  if (start === undefined && end === undefined) {
    return undefined;
  }
  if (start !== undefined && end !== undefined && start > end) {
    throw new RangeError("Range start must be less than or equal to end");
  }
  if (start === undefined) {
    return `bytes=-${end}`;
  }
  if (end === undefined) {
    return `bytes=${start}-`;
  }
  return `bytes=${start}-${end}`;
}

function normalizeRangeBoundary(
  value: number | undefined,
  label: "start" | "end",
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new RangeError(`Range ${label} must be a finite number`);
  }
  if (value < 0) {
    throw new RangeError(`Range ${label} cannot be negative`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`Range ${label} must be an integer`);
  }
  return value;
}

function setMultiValueHeader(
  headers: Headers,
  name: string,
  value: string | string[] | undefined,
): void {
  const normalized = normalizeHeaderValues(value);
  if (normalized) {
    headers.set(name, normalized);
  }
}

function normalizeHeaderValues(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  const filtered = list
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (filtered.length === 0) {
    return undefined;
  }
  return filtered.join(", ");
}

function formatHttpDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toUTCString();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) {
    throw new TypeError("Invalid HTTP date string provided");
  }
  return new Date(time).toUTCString();
}
