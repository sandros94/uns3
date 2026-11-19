import type { BucketStyle } from "../../types.ts";
import { uriEncode } from "../utils/encode.ts";
import { isDnsCompatibleBucketName, isIpAddress } from "../utils/is.ts";

type EndpointStyle<T extends BucketStyle = BucketStyle> = T extends "virtual"
  ? { bucket: string; bucketStyle: "virtual" }
  : T extends "path"
    ? { bucket?: string; bucketStyle: "path" }
    : never;

export type EndpointInput<T extends BucketStyle = BucketStyle> = EndpointStyle<T> & {
  key: string;
  endpoint: string;
};

/**
 * Builds a request URL for the given bucket/key combo respecting the desired
 * bucket addressing style.
 *
 * Virtual-hosted style falls back to path style whenever the bucket cannot be
 * reached as a subdomain of the endpoint: a name that is not DNS-compatible, a
 * dotted name over `https:` (a wildcard certificate covers a single label), or
 * an endpoint addressed by IP literal or as `localhost`.
 *
 * Throws on a bucket named `.` or `..`, which URL parsing removes from a path.
 *
 * @param input - Endpoint components including style, bucket, and key.
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
 * Encodes an S3 object key using RFC 3986 rules while preserving path
 * separators and every empty segment, leading, inner and trailing alike. A key
 * is sent exactly as written: `/foo` and `foo` are two different objects.
 *
 * Throws on a key containing a `.` or `..` path segment. S3's key space is
 * flat, so `dir/../evil.txt` is a name; a URL's path is not, and every WHATWG
 * URL parser — which is every `URL`, every `Request`, and therefore every
 * `fetch` — removes dot segments while parsing. Such a key used to be rewritten
 * on its way out: `dir/../evil.txt` was silently stored as `evil.txt`, and
 * `users/a/../b/x` silently left the prefix it was scoped to. Percent-encoding
 * does not rescue it either, because the specification counts `%2e` as a dot
 * for exactly this purpose. A fetch-based client cannot put such a key on the
 * wire, so it says so instead of writing somewhere else.
 *
 * Only a whole segment of one or two dots is affected; dots inside a name
 * (`a.b`, `c..d`, `...`) are ordinary characters and pass through untouched.
 *
 * @param key - Raw key as provided by callers.
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
