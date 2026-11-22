import { uriEncode } from "./internal/encode.ts";
import { isDnsCompatibleBucketName, isIpAddress } from "./internal/is.ts";
import type { BucketStyle } from "./types.ts";

type EndpointStyle<T extends BucketStyle = BucketStyle> = T extends "virtual"
  ? { bucket: string; bucketStyle: "virtual" }
  : T extends "path"
    ? { bucket?: string; bucketStyle: "path" }
    : never;

/**
 * Options of {@link buildRequestUrl}. Virtual-hosted style needs a `bucket`,
 * path style can leave it out to address the endpoint itself.
 */
export type EndpointInput<T extends BucketStyle = BucketStyle> = EndpointStyle<T> & {
  /** Object key, or `""` for a request on the bucket itself. */
  key: string;
  /** Endpoint of the store, such as `"https://s3.us-east-1.amazonaws.com"`. */
  endpoint: string;
};

/**
 * Builds the URL of a request on a bucket or an object.
 *
 * Virtual-hosted style falls back to path style where the bucket cannot be a
 * subdomain of the endpoint: a name that is not DNS-compatible, a dotted name
 * over `https:`, and an IP or `localhost` endpoint.
 *
 * @param input - Endpoint, bucket style, bucket and key.
 * @returns The request URL, the key encoded the way S3 expects it.
 * @throws {Error} When a virtual-hosted request has no bucket, or the bucket or key contains a `.` or `..` path segment.
 * @example
 * ```ts
 * import { buildRequestUrl } from "uns3/endpoint";
 *
 * const url = buildRequestUrl({
 *   endpoint: "https://s3.us-east-1.amazonaws.com",
 *   bucketStyle: "virtual",
 *   bucket: "my-bucket",
 *   key: "photos/cat 1.jpg",
 * });
 * // https://my-bucket.s3.us-east-1.amazonaws.com/photos/cat%201.jpg
 * ```
 */
export function buildRequestUrl<T extends BucketStyle>(input: EndpointInput<T>): URL {
  const { endpoint, bucketStyle, bucket, key } = input;
  const base = new URL(endpoint);

  if (!bucket) {
    if (bucketStyle === "virtual") {
      throw new Error("Bucket is required for virtual-hosted-style requests");
    }
  } else if (resolveBucketStyle(bucketStyle, bucket, base) === "virtual") {
    base.hostname = `${bucket}.${base.hostname}`;
  } else {
    if (DOT_SEGMENT.test(bucket)) {
      throw new Error(
        `Bucket ${JSON.stringify(bucket)} is a dot segment, which URL parsing removes instead of sending.`,
      );
    }
    const basePath = normalizeBasePath(base.pathname);
    base.pathname = `${basePath}/${encodeURIComponent(bucket)}`;
  }

  const encodedKey = encodeS3Key(key);
  const basePath = normalizeBasePath(base.pathname);
  base.pathname = encodedKey ? `${basePath}/${encodedKey}` : basePath;
  return base;
}

/**
 * Percent-encodes an object key for a URL path (RFC 3986), keeping every `/`
 * and every empty segment. `/foo` and `foo` stay two different keys.
 *
 * A key with a `.` or `..` path segment, such as `dir/../evil.txt`, cannot
 * be sent: every URL parser removes such segments, so the request would write
 * to another key. Dots inside a name, such as `a.b` or `c..d`, are kept.
 *
 * @param key - The object key.
 * @returns The key, encoded for a URL path.
 * @throws {Error} When the key contains a `.` or `..` path segment.
 * @example
 * ```ts
 * import { encodeS3Key } from "uns3/endpoint";
 *
 * encodeS3Key("photos/cat 1.jpg"); // "photos/cat%201.jpg"
 * ```
 */
export function encodeS3Key(key: string): string {
  if (!key) return "";
  return key
    .split("/")
    .map((segment) => {
      if (DOT_SEGMENT.test(segment)) {
        throw new Error(
          `Object key ${JSON.stringify(key)} contains a "${segment}" dot segment, which URL parsing removes instead of sending. Rename the key: no encoding of a dot segment survives a URL.`,
        );
      }
      return uriEncode(segment);
    })
    .join("/");
}

// #region Internal

const DOT_SEGMENT = /^\.{1,2}$/;

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed;
}

function resolveBucketStyle(preferred: BucketStyle, bucket: string, base: URL): BucketStyle {
  if (preferred === "path" || !isDnsCompatibleBucketName(bucket)) {
    return "path";
  }

  if (base.protocol === "https:" && bucket.includes(".")) {
    return "path";
  }

  if (isIpAddress(base.hostname) || base.hostname === "localhost") {
    return "path";
  }

  return "virtual";
}
