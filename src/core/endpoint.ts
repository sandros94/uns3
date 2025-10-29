import type { BucketStyle } from "../types";
import { uriEncode } from "../utils";

type EndpointStyle<T extends BucketStyle = BucketStyle> = T extends "virtual"
  ? { bucket?: string; bucketStyle: "virtual" }
  : T extends "path"
    ? { bucket: string; bucketStyle: "path" }
    : never;

export type EndpointInput<T extends BucketStyle = BucketStyle> =
  EndpointStyle<T> & {
    key: string;
    endpoint: string;
  };

/**
 * Builds a request URL for the given bucket/key combo respecting the desired
 * bucket addressing style.
 *
 * @param input - Endpoint components including style, bucket, and key.
 */
export function buildRequestUrl<T extends BucketStyle>(
  input: EndpointInput<T>,
): URL {
  const { endpoint, bucketStyle, bucket, key } = input;
  if (!bucket && bucketStyle !== "path") {
    throw new Error("Bucket is required for virtual-hosted-style requests");
  }

  const base = new URL(endpoint);
  const finalBucketStyle = bucket ? bucketStyle : "virtual";
  if (bucket && finalBucketStyle === "virtual") {
    base.hostname = `${bucket}.${base.hostname}`;
  } else if (bucket && finalBucketStyle === "path") {
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
 * separators and significant empty segments (e.g. trailing slashes).
 *
 * @param key - Raw key as provided by callers.
 */
export function encodeS3Key(key: string): string {
  if (!key) return "";
  return key
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

// #region Internal

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed;
}
