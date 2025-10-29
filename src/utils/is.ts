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
