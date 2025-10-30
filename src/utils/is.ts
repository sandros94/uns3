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
export function isReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  );
}

const IP_ADDRESS_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

function looksLikeIpAddress(value: string): boolean {
  return IP_ADDRESS_REGEX.test(value);
}

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
  if (looksLikeIpAddress(bucket)) {
    return false;
  }
  return true;
}
