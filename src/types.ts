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
  /** Maximum number of attempts (including the initial request). */
  maxAttempts: number;
  /** Base delay in milliseconds between retries; doubled on each subsequent attempt. */
  baseDelayMs: number;
  /** When `true`, adds random jitter to the retry delay to reduce thundering-herd effects. */
  jitter?: boolean;
  /** Custom predicate to decide whether a failed request should be retried. Receives the response (if any) and the thrown error. */
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
  /** URL style for bucket addressing. Defaults to `"virtual"`. */
  bucketStyle?: BucketStyle;
  /** Custom `fetch` implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Custom resolver for deriving content types from object keys. */
  contentTypeResolver?: ContentTypeResolver;
  /** Manual clock skew offset in milliseconds applied to request signatures. */
  clockSkewMs?: number;
  /** Retry configuration for transient failures. */
  retry?: RetryConfig;
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
  /** Expected HTTP status code(s); a mismatch throws an `S3Error`. */
  expectedStatus?: number | number[];
  /** Abort signal to cancel the request. */
  signal?: AbortSignal;
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
  /** Request body; plain objects are JSON-serialized automatically. */
  body: BodyInit | ReadableStream<Uint8Array> | null | object;
  /** Explicit MIME type. Set to `false` to suppress automatic detection. */
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
  /** Explicit MIME type. Set to `false` to suppress automatic detection. */
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
  /** Hint for providers that require an explicit Content-Length header. Not validated against the actual body size — the caller is responsible for accuracy. */
  contentLength?: number;
}

/** Result of a single part upload. */
export interface UploadPartResult {
  /** ETag returned by S3 for this part, required when completing the upload. */
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
    /** Object ETag, if available. */
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
}

/** HTTP methods that can be used for presigned URLs. */
export type PresignMethod = "GET" | "PUT" | "HEAD" | "DELETE";

/** Parameters for generating a presigned URL. */
export interface PresignParams extends BaseRequest {
  /** HTTP method the presigned URL will authorize. */
  method: PresignMethod;
  /** URL validity duration in seconds. Defaults vary by provider (typically 3600). */
  expiresInSeconds?: number;
}

/** Resolves a content type from an object key and an optional explicit value. Return `undefined` to omit the header. */
export type ContentTypeResolver = (key: string, explicit?: string | false) => string | undefined;

/** Metadata produced by the SigV4 signing process. */
export interface SignedRequestMetadata {
  /** The full `Authorization` header value. */
  authorization: string;
  /** `x-amz-date` timestamp used in the signature. */
  amzDate: string;
  /** Semicolon-delimited list of headers included in the signature. */
  signedHeaders: string;
}

/** Input required to sign an outgoing request. */
export interface SigningInit {
  /** HTTP method (e.g., `"GET"`, `"PUT"`). */
  method: string;
  /** Fully-resolved request URL. */
  url: URL;
  /** Request headers to include in the signature. */
  headers: Headers;
  /** Pre-computed hex-encoded SHA-256 hash of the payload, or `"UNSIGNED-PAYLOAD"`. */
  payloadHash?: string;
}

/** Result of signing request headers with SigV4. */
export interface SignedHeaderResult {
  /** Headers augmented with the `Authorization` and `x-amz-date` headers. */
  headers: Headers;
  /** Signing metadata for inspection or debugging. */
  metadata: SignedRequestMetadata;
}

/** Result of generating a presigned URL. */
export interface PresignedUrlResult {
  /** The presigned URL with query-string authentication parameters. */
  url: URL;
}

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
