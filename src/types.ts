export type UppercaseOrLowercase<T extends string> = Uppercase<T> | Lowercase<T>;
export type Methods = UppercaseOrLowercase<"GET" | "HEAD" | "POST" | "PUT" | "DELETE">;

/** Static AWS credentials used to sign requests. */
export type Credentials = {
  /** AWS access key identifier. */
  accessKeyId: string;
  /** AWS secret access key used for SigV4 signing. */
  secretAccessKey: string;
  /** Optional session token for temporary credentials (e.g., STS). */
  sessionToken?: string;
};

/** A function that returns credentials, either synchronously or as a promise. Useful for credential rotation or fetching from external sources. */
export type CredentialsProvider = () => Promise<Credentials> | Credentials;

/** Determines how the bucket name is placed in the request URL: `"virtual"` for virtual-hosted style or `"path"` for path-style. */
export type BucketStyle = "virtual" | "path";

/** Byte range for partial object retrieval (Range header). */
export interface ByteRange {
  /** Zero-based start offset (inclusive). */
  start?: number;
  /** Zero-based end offset (inclusive). */
  end?: number;
}

/** Conditional request headers for cache validation and optimistic concurrency. */
export interface ConditionalHeaders {
  /** Only return the object if its ETag matches one of these values. */
  ifMatch?: string | string[];
  /** Only return the object if its ETag does not match any of these values. */
  ifNoneMatch?: string | string[];
  /** Only return the object if it has been modified after this date. */
  ifModifiedSince?: Date | string;
  /** Only return the object if it has not been modified after this date. */
  ifUnmodifiedSince?: Date | string;
}

/**
 * Controls automatic retry behavior for failed requests.
 *
 * @example
 * ```ts
 * const retry: RetryConfig = {
 *   maxAttempts: 3,
 *   baseDelayMs: 200,
 *   jitter: true,
 * };
 * ```
 */
export interface RetryConfig {
  /** Maximum number of attempts, the initial request included. A positive integer, defaults to `3`. */
  maxAttempts?: number;
  /** Base delay in milliseconds between retries, doubled on each subsequent attempt. Defaults to `100`. */
  baseDelayMs?: number;
  /**
   * Longest delay in milliseconds between two attempts, a `Retry-After` from
   * the store included. Defaults to `20000`.
   */
  maxDelayMs?: number;
  /** When `true` (the default), adds random jitter to the retry delay to reduce thundering-herd effects. */
  jitter?: boolean;
  /**
   * Custom predicate to decide whether a failed request should be retried.
   * Receives the response (if any) and the thrown error, once per failed
   * attempt.
   *
   * It is the decision, not a filter on it: the default rule — retry a
   * `429`, a `5xx` other than `501` and `505`, a throttling or timeout
   * error code, and a request that failed in transit — is replaced by whatever
   * this returns. The body is re-sent as given, which is fine for a string, a
   * buffer or a `Blob`. A `ReadableStream` body is consumed by the first
   * attempt and is never retried whatever this returns, since there is nothing
   * left to send. A predicate that throws is read as `false`.
   */
  retriable?: (res: Response | undefined, err: unknown) => boolean;
}

/**
 * Configures request body integrity checking.
 *
 * @example
 * ```ts
 * const checksum: ChecksumConfig = {
 *   algorithm: "crc32c",
 *   requireOnPut: true,
 * };
 * ```
 */
export interface ChecksumConfig {
  /** Hash algorithm used for checksum computation. `"none"` disables checksums. */
  algorithm: "none" | "sha256" | "crc32c";
  /** When `true`, PUT requests will include a checksum header. */
  requireOnPut?: boolean;
}

/**
 * Configuration for creating an {@link S3Client} instance.
 *
 * @example
 * ```ts
 * const config: S3ClientConfig = {
 *   endpoint: "https://s3.us-east-1.amazonaws.com",
 *   region: "us-east-1",
 *   credentials: {
 *     accessKeyId: "AKIA...",
 *     secretAccessKey: "wJal...",
 *   },
 *   defaultBucket: "my-bucket",
 * };
 * ```
 */
export interface S3ClientConfig {
  /** S3-compatible endpoint URL (e.g., `"https://s3.us-east-1.amazonaws.com"`). */
  endpoint: string;
  /** Signing region. Defaults to `"auto"` — acceptable for most S3-compatible providers; AWS buckets should specify the actual region. */
  region?: string;
  /** Static credentials or an async provider function for request signing. */
  credentials?: Credentials | CredentialsProvider;
  /** Bucket name used when individual requests omit `bucket`. */
  defaultBucket?: string;
  /**
   * URL style for bucket addressing. Defaults to `"virtual"`, which falls back
   * to path style for buckets a subdomain cannot reach: names that are not
   * DNS-compatible, dotted names over HTTPS, and IP or `localhost` endpoints.
   */
  bucketStyle?: BucketStyle;
  /** Custom `fetch` implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Custom resolver for deriving content types from object keys. */
  contentTypeResolver?: ContentTypeResolver;
  /** Manual clock skew offset in milliseconds applied to request signatures. */
  clockSkewMs?: number;
  /** Retry configuration for transient failures. */
  retry?: RetryConfig;
  /**
   * Deadline in milliseconds of each attempt that moves no object bytes
   * (`head`, `del`, `list` and the multipart calls but `uploadPart`), up to
   * the end of its response. Also bounds reading an error body, whatever the
   * request. `false` disables it. Defaults to `30000`.
   */
  timeoutMs?: number | false;
  /** Checksum configuration for request body integrity. */
  checksum?: ChecksumConfig;
}

/** Common fields shared by all S3 operation parameter types. */
export interface BaseRequest {
  /** Target bucket name; falls back to `S3ClientConfig.defaultBucket` if omitted. */
  bucket?: string;
  /** Object key (path) within the bucket. */
  key?: string;
  /** Additional HTTP headers merged into the request. */
  headers?: HeadersInit;
  /** Extra query string parameters appended to the request URL. */
  query?: Record<
    string,
    string | number | boolean | undefined | Array<string | number | boolean | undefined>
  >;
  /**
   * Expected HTTP status code(s); a mismatch throws an `S3Error`. Replaces the
   * calling method's default list rather than adding to it, so asking for `200`
   * alone makes a `304` an error. Ignored by `getSignedUrl`, which sends nothing.
   */
  expectedStatus?: number | number[];
  /** Abort signal to cancel the request, retries included. */
  signal?: AbortSignal;
  /**
   * Deadline in milliseconds of each attempt, up to the response it is
   * answered with. A timed-out attempt is retried like any failed one.
   * Replaces the client's `timeoutMs` for this request. `get`, `put` and
   * `uploadPart` have no deadline unless one is set here, since a large
   * transfer has no honest default. `false` disables it.
   */
  timeoutMs?: number | false;
}

/** Parameters for requests that operate on a single object, including conditional and range headers. */
export interface ObjectRequest extends BaseRequest, ConditionalHeaders {
  /** Object key (required). */
  key: string;
  /** Byte range for partial reads. */
  range?: ByteRange;
}

/** Parameters for `getObject`. */
export type GetObjectParams = ObjectRequest;

/** Parameters for `headObject`. */
export type HeadObjectParams = ObjectRequest;

/** Parameters for `putObject`. */
export interface PutObjectParams
  extends BaseRequest, Pick<ConditionalHeaders, "ifMatch" | "ifNoneMatch"> {
  /** Object key to write. */
  key: string;
  /**
   * Request body; plain objects are JSON-serialized automatically.
   *
   * A `ReadableStream` is sent as it arrives and is never retried: it is
   * consumed by the attempt that sent it, so there is no second attempt to
   * make. It is also signed as `UNSIGNED-PAYLOAD` and cannot be checksummed —
   * hashing it would mean buffering it, which is the thing a stream is for
   * avoiding.
   */
  body: BodyInit | ReadableStream<Uint8Array> | null | object;
  /**
   * Declares the body's size in bytes, which is what makes a streamed upload
   * work everywhere. A `ReadableStream` with no length goes out as
   * `Transfer-Encoding: chunked`, and RustFS — like AWS S3 — refuses that with
   * `411 MissingContentLength`; declaring the length makes the runtime send a
   * fixed-length body instead. Not validated against the actual body size — the
   * caller is responsible for accuracy.
   *
   * The header is signed with the rest of the request, so a wrong value is not
   * a wrong number: too small and the store rejects the signature or the body,
   * too large and the connection waits for bytes that never come and surfaces
   * as a bare `fetch failed`. Pass the body's byte length or leave it out.
   */
  contentLength?: number;
  /**
   * Explicit MIME type, ahead of a `content-type` header, the body's own type
   * (a Blob's, or JSON for a plain object) and inference from the key, in that
   * order. `false` sends no content type at all.
   */
  contentType?: string | false;
  /** Value for the `Cache-Control` header. */
  cacheControl?: string;
  /** Value for the `Content-Disposition` header. */
  contentDisposition?: string;
  /** Value for the `Content-Encoding` header (e.g., `"gzip"`). */
  contentEncoding?: string;
}

/** Parameters for `deleteObject`. */
export interface DeleteObjectParams extends BaseRequest {
  /** Object key to delete. */
  key: string;
}

/** Parameters for initiating a multipart upload. */
export interface MultipartInitParams extends BaseRequest {
  /** Object key for the multipart upload. */
  key: string;
  /**
   * Explicit MIME type, ahead of a `content-type` header and inference from the
   * key, in that order. `false` sends no content type at all.
   */
  contentType?: string | false;
  /** Value for the `Cache-Control` header. */
  cacheControl?: string;
  /** Value for the `Content-Disposition` header. */
  contentDisposition?: string;
  /** Value for the `Content-Encoding` header. */
  contentEncoding?: string;
}

/** Result of initiating a multipart upload. */
export interface MultipartInitResult {
  /** Server-assigned upload identifier used in subsequent part and completion requests. */
  uploadId: string;
}

/** Parameters for uploading a single part in a multipart upload. */
export interface UploadPartParams extends BaseRequest {
  /** Object key matching the initiated upload. */
  key: string;
  /** Upload identifier returned by `multipartInit`. */
  uploadId: string;
  /** 1-based part number (must be unique within the upload). */
  partNumber: number;
  /** Body content for this part. */
  body: BodyInit | ReadableStream<Uint8Array> | null;
  /**
   * Hint for providers that require an explicit `Content-Length` header. Not
   * validated against the actual body size — the caller is responsible for
   * accuracy.
   *
   * The header is signed with the rest of the request, so a wrong value is not
   * a wrong number: too small and the store rejects the signature or the body,
   * too large and the connection waits for bytes that never come and surfaces
   * as a bare `fetch failed`. Pass the body's byte length or leave it out.
   */
  contentLength?: number;
}

/** Result of a single part upload. */
export interface UploadPartResult {
  /** ETag of this part as a quoted entity tag, required when completing the upload. */
  etag: string;
}

/** Parameters for completing a multipart upload. */
export interface CompleteMultipartParams
  extends BaseRequest, Pick<ConditionalHeaders, "ifMatch" | "ifNoneMatch"> {
  /** Object key matching the initiated upload. */
  key: string;
  /** Upload identifier returned by `multipartInit`. */
  uploadId: string;
  /** Ordered list of uploaded parts with their part numbers and ETags. */
  parts: Array<{ partNumber: number; etag: string }>;
}

/** Result of completing a multipart upload. */
export interface CompleteMultipartResult {
  /** ETag of the assembled object as a quoted entity tag. */
  etag: string;
  /** URL of the assembled object, when the store reports one. */
  location?: string;
}

/** Parameters for aborting an in-progress multipart upload. */
export interface AbortMultipartParams extends BaseRequest {
  /** Object key matching the initiated upload. */
  key: string;
  /** Upload identifier to abort. */
  uploadId: string;
}

/** Parameters for listing objects (ListObjectsV2). */
export interface ListObjectsV2Params extends BaseRequest {
  /** Only include keys that begin with this prefix. */
  prefix?: string;
  /** Separator used to group keys into common prefixes (typically `"/"`). */
  delimiter?: string;
  /** Token from a previous truncated response to fetch the next page. */
  continuationToken?: string;
  /** Maximum number of keys to return per request. */
  maxKeys?: number;
}

/** Parsed response from a ListObjectsV2 request. */
export interface ListObjectsV2Response {
  /** Objects matching the list request. */
  contents: Array<{
    /** Object key. */
    key: string;
    /** Object size in bytes. */
    size: number;
    /** Object ETag as a quoted entity tag, the form a HEAD reports, if available. */
    etag: string | undefined;
    /** ISO 8601 timestamp of the last modification. */
    lastModified: string;
    /** Storage class (e.g., `"STANDARD"`, `"GLACIER"`). */
    storageClass?: string;
  }>;
  /** Rolled-up key prefixes when a `delimiter` was used. */
  commonPrefixes: string[];
  /** `true` when there are more results available via `nextContinuationToken`. */
  isTruncated: boolean;
  /** Pass this value as `continuationToken` to fetch the next page of results. */
  nextContinuationToken?: string;
  /**
   * The `NextMarker` of a store that answered V1-style pagination, present only
   * when it sent one — several S3-compatible stores ignore `list-type=2` and
   * page this way, in which case `isTruncated` is `true` and
   * `nextContinuationToken` is absent.
   *
   * It is not a continuation token and does not work as one: pass it back as
   * `query: { marker }` rather than as `continuationToken`.
   */
  nextMarker?: string;
}

/** HTTP methods that can be used for presigned URLs. */
export type PresignMethod = "GET" | "PUT" | "HEAD" | "DELETE";

/** Parameters for generating a presigned URL. */
export interface PresignParams extends BaseRequest {
  /** HTTP method the presigned URL will authorize. */
  method: PresignMethod;
  /** URL validity in seconds, an integer from 1 to 604800 (seven days). Defaults to 900. */
  expiresInSeconds?: number;
}

/** Resolves a content type from an object key and an optional explicit value. Return `undefined` to omit the header. */
export type ContentTypeResolver = (key: string, explicit?: string | false) => string | undefined;

/** Options passed to the transport layer when executing a request. */
export interface TransportOptions {
  /** The fully-constructed `Request` object to send. */
  request: Request;
  /** Optional abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** Response returned by the transport layer. */
export interface TransportResult {
  /** The raw `Response` object from `fetch`. */
  response: Response;
}
