/**
 * Type guard detecting {@link ArrayBuffer} values in environments where the
 * constructor is present.
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer;
}

/**
 * Type guard detecting typed array and DataView instances.
 */
export function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

/**
 * Type guard detecting {@link Blob} values while accounting for runtimes
 * without Blob support.
 */
export function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Type guard detecting Web {@link ReadableStream} objects.
 */
export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

const IPV4_ADDRESS_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_HOST_REGEX = /^\[[\da-f:.]+\]$/i;

/**
 * Checks whether a value is an IP address in the form a URL host carries it:
 * a dotted IPv4 address, or a bracketed IPv6 literal such as `[::1]`.
 */
export function isIpAddress(value: string): boolean {
  return IPV4_ADDRESS_REGEX.test(value) || IPV6_HOST_REGEX.test(value);
}

/**
 * Checks whether a bucket name is DNS-compatible per S3 naming rules (3-63 chars, lowercase alphanumeric, dots, hyphens).
 */
export function isDnsCompatibleBucketName(bucket: string): boolean {
  if (bucket.length < 3 || bucket.length > 63) {
    return false;
  }
  if (
    bucket.startsWith(".") ||
    bucket.startsWith("-") ||
    bucket.endsWith(".") ||
    bucket.endsWith("-")
  ) {
    return false;
  }
  if (bucket.includes("..")) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(bucket)) {
    return false;
  }
  if (isIpAddress(bucket)) {
    return false;
  }
  return true;
}

/**
 * Type guard that returns true for plain objects and arrays, excluding BodyInit types and other built-in instances.
 */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // Exclude primitive-like objects and built-in types that should not be stringified.
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    value instanceof RegExp
  ) {
    return false;
  }

  // Exclude Blob, ArrayBuffer, ArrayBufferView, and ReadableStream which are valid BodyInit types
  if (
    isBlob(value) ||
    isArrayBuffer(value) ||
    isArrayBufferView(value) ||
    isReadableStream(value)
  ) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Array.isArray(value);
}
