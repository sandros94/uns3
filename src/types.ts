import type { SigningKeyCache } from "./signer.ts";

/** A string type in upper or lower case only, such as `"GET"` or `"get"`. */
export type UppercaseOrLowercase<T extends string> = Uppercase<T> | Lowercase<T>;

/** An HTTP method the signer accepts, in upper or lower case. */
export type Methods = UppercaseOrLowercase<"GET" | "HEAD" | "POST" | "PUT" | "DELETE">;

/**
 * The credentials requests are signed with.
 *
 * @example
 * ```ts
 * const credentials: Credentials = {
 *   accessKeyId: "your_access_key_id",
 *   secretAccessKey: "your_secret_access_key",
 * };
 * ```
 */
export type Credentials = {
  /** Access key ID. */
  accessKeyId: string;
  /** Secret access key. */
  secretAccessKey: string;
  /** Session token of temporary credentials, such as those from AWS STS. */
  sessionToken?: string;
};

/**
 * A function the client calls before every request to get the credentials to
 * sign it with. Use it for credentials that rotate or come from elsewhere.
 *
 * @example
 * ```ts
 * const credentials: CredentialsProvider = async () => await vault.read("s3");
 * ```
 */
export type CredentialsProvider = () => Promise<Credentials> | Credentials;

/**
 * Where the bucket name goes in a request URL: `"virtual"` puts it in the host
 * (`my-bucket.s3.amazonaws.com`), `"path"` in the path
 * (`s3.amazonaws.com/my-bucket`).
 */
export type BucketStyle = "virtual" | "path";

/**
 * The bytes of an object to read. Pass `start`, `end` or both, or `suffix`
 * alone.
 *
 * @example
 * ```ts
 * const first: ByteRange = { end: 1023 }; // bytes 0 to 1023
 * const rest: ByteRange = { start: 1024 }; // byte 1024 to the end
 * const last: ByteRange = { suffix: 1024 }; // the last 1024 bytes
 * ```
 */
export interface ByteRange {
  /**
   * First byte to read, zero-based.
   *
   * @default 0
   */
  start?: number;
  /**
   * Last byte to read, zero-based and inclusive.
   *
   * @default the last byte of the object
   */
  end?: number;
  /** Number of bytes to read from the end of the object. Cannot be combined with `start` or `end`. */
  suffix?: number;
}

/** Conditions a request only succeeds under. A failed one answers `304` or `412`. */
export interface ConditionalHeaders {
  /** Succeed only if the object's ETag is one of these. */
  ifMatch?: string | string[];
  /** Succeed only if the object's ETag is none of these. `"*"` means "only if no object exists". */
  ifNoneMatch?: string | string[];
  /** Succeed only if the object changed after this date. */
  ifModifiedSince?: Date | string;
  /** Succeed only if the object did not change after this date. */
  ifUnmodifiedSince?: Date | string;
}

/**
 * When and how often a failed request is sent again.
 *
 * By default a request is retried on a `429`, a `5xx` other than `501` and
 * `505`, a throttling or timeout error code, and a failure in transit. A
 * `ReadableStream` body is never retried, since the first attempt consumed it.
 *
 * @example
 * ```ts
 * const retry: RetryConfig = { maxAttempts: 5, baseDelayMs: 200 };
 * ```
 */
export interface RetryConfig {
  /**
   * Attempts in all, the first one included. A positive integer.
   *
   * @default 3
   */
  maxAttempts?: number;
  /**
   * Delay in milliseconds before the first retry, doubled for each one after.
   *
   * @default 100
   */
  baseDelayMs?: number;
  /**
   * Longest delay in milliseconds between two attempts, a `Retry-After` from
   * the store included.
   *
   * @default 20000
   */
  maxDelayMs?: number;
  /**
   * Randomizes each delay between half and all of it, so clients that failed
   * together do not retry together.
   *
   * @default true
   */
  jitter?: boolean;
  /**
   * Decides whether a failed attempt is retried, in place of the default
   * rule. It gets the response, or `undefined` when the request failed in
   * transit, and the error the attempt failed with. Returning `true` for a
   * `ReadableStream` body has no effect, and a predicate that throws counts as
   * `false`.
   *
   * @example
   * ```ts
   * const retriable = (response?: Response) => !response || response.status >= 500;
   * ```
   */
  retriable?: (res: Response | undefined, err: unknown) => boolean;
}

/**
 * Integrity checksums on uploads. The store verifies the checksum and refuses
 * a body that does not match it.
 *
 * @example
 * ```ts
 * const checksum: ChecksumConfig = { algorithm: "crc32c", requireOnPut: true };
 * ```
 */
export interface ChecksumConfig {
  /** Algorithm of the checksum sent with each `put` and `uploadPart` body. `"none"` sends none. */
  algorithm: "none" | "sha256" | "crc32c";
  /**
   * Refuse a body that cannot be hashed, a `ReadableStream` or a Blob over
   * 16 MiB, instead of sending it without a checksum. `initiateMultipart`
   * then also declares the algorithm, since every part carries it. A checksum
   * header you set yourself is always sent as it is.
   *
   * @default false
   */
  requireOnPut?: boolean;
}

/**
 * Options of an {@link S3Client}.
 *
 * @example
 * ```ts
 * const config: S3ClientConfig = {
 *   endpoint: "https://s3.us-east-1.amazonaws.com",
 *   region: "us-east-1",
 *   credentials: {
 *     accessKeyId: "your_access_key_id",
 *     secretAccessKey: "your_secret_access_key",
 *   },
 *   defaultBucket: "my-bucket",
 * };
 * ```
 */
export interface S3ClientConfig {
  /** Endpoint of the store, such as `"https://s3.us-east-1.amazonaws.com"`. */
  endpoint: string;
  /**
   * Region requests are signed for. S3-compatible stores accept `"auto"`,
   * AWS needs the bucket's region.
   *
   * @default "auto"
   */
  region?: string;
  /** Credentials to sign with, or a function returning them. Leave it out to send requests unsigned. */
  credentials?: Credentials | CredentialsProvider;
  /** Bucket of every request that names none. */
  defaultBucket?: string;
  /**
   * Where the bucket name goes in a request URL. `"virtual"` falls back to
   * path style where a subdomain cannot work: bucket names that are not
   * DNS-compatible, dotted names over HTTPS, and IP or `localhost` endpoints.
   *
   * @default "virtual"
   */
  bucketStyle?: BucketStyle;
  /**
   * The `fetch` requests are sent with.
   *
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;
  /**
   * Infers the content type of an upload from its key. Build one with
   * `createContentTypeResolver` from `uns3/mime`.
   *
   * @default the `common` group from `uns3/mime`
   */
  contentTypeResolver?: ContentTypeResolver;
  /**
   * Milliseconds added to the local clock when signing. The client also
   * corrects its clock once the store's is five minutes or more away.
   *
   * @default 0
   */
  clockSkewMs?: number;
  /** When and how often a failed request is sent again. */
  retry?: RetryConfig;
  /**
   * Where the client keeps derived signing keys. Pass a `SigningKeyCache` of
   * its own to isolate the client, or `false` to derive a key on every
   * request.
   *
   * @default sharedSigningKeyCache from `uns3/signer`
   */
  signingKeyCache?: SigningKeyCache | false;
  /**
   * Deadline in milliseconds of each attempt of `head`, `del`, `list` and the
   * multipart calls but `uploadPart`, up to the end of the response. It also
   * bounds reading an error body, whatever the request. A timed-out attempt
   * is retried. `false` sets no deadline.
   *
   * @default 30000
   */
  timeoutMs?: number | false;
  /** Integrity checksums on uploads. */
  checksum?: ChecksumConfig;
}

/** Options every request takes. */
export interface BaseRequest {
  /** Bucket of the request. Defaults to the client's `defaultBucket`. */
  bucket?: string;
  /** Object key. */
  key?: string;
  /** Headers to send, in addition to the ones the client sets. */
  headers?: HeadersInit;
  /** Query parameters to send. A typed option of the same name wins over one here. */
  query?: Record<
    string,
    string | number | boolean | undefined | Array<string | number | boolean | undefined>
  >;
  /**
   * Statuses that count as success. Any other throws an `S3Error`. Your list
   * replaces the method's default rather than adding to it.
   *
   * @example
   * ```ts
   * await client.put({ key: "a.txt", body: "hi", expectedStatus: [200, 201] });
   * ```
   */
  expectedStatus?: number | number[];
  /** Aborts the request, retries included. The request rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Deadline in milliseconds of each attempt, up to the response. A timed-out
   * attempt is retried. Replaces the client's `timeoutMs` for this request.
   * `false` sets no deadline.
   *
   * @default the client's `timeoutMs`, none for `get`, `put` and `uploadPart`
   */
  timeoutMs?: number | false;
}

/** Options of a request on one object. */
export interface ObjectRequest extends BaseRequest, ConditionalHeaders {
  /** Object key. */
  key: string;
  /** Bytes of the object to read. The response is a `206`. */
  range?: ByteRange;
}

/** Options of `get`. */
export type GetObjectParams = ObjectRequest;

/** Options of `head`. */
export type HeadObjectParams = ObjectRequest;

/** Options of `put`. */
export interface PutObjectParams
  extends BaseRequest, Pick<ConditionalHeaders, "ifMatch" | "ifNoneMatch"> {
  /** Object key. */
  key: string;
  /**
   * The object's content. A plain object or an array is sent as JSON. A
   * `ReadableStream` is sent as it arrives, without a payload signature or a
   * checksum, and is never retried.
   */
  body: BodyInit | ReadableStream<Uint8Array> | null | Record<string, unknown> | unknown[];
  /**
   * The body's size in bytes. Pass it with a `ReadableStream`: AWS S3 and
   * other stores refuse a body of unknown length with `411`. It is signed, so
   * it must be exact: a wrong length fails the request.
   */
  contentLength?: number;
  /**
   * The object's content type. `false` sends none.
   *
   * @default a `content-type` header, else the body's own type (a Blob's, or
   * JSON for a plain object), else the type the client's resolver infers from
   * the key
   */
  contentType?: string | false;
  /** The object's `Cache-Control`. */
  cacheControl?: string;
  /** The object's `Content-Disposition`. */
  contentDisposition?: string;
  /** The object's `Content-Encoding`, such as `"gzip"`. */
  contentEncoding?: string;
}

/** Options of `del`. */
export interface DeleteObjectParams extends BaseRequest {
  /** Object key. */
  key: string;
}

/** Options of `initiateMultipart`. */
export interface MultipartInitParams extends BaseRequest {
  /** Key of the object the upload creates. */
  key: string;
  /**
   * The object's content type. `false` sends none.
   *
   * @default a `content-type` header, else the type the client's resolver
   * infers from the key
   */
  contentType?: string | false;
  /** The object's `Cache-Control`. */
  cacheControl?: string;
  /** The object's `Content-Disposition`. */
  contentDisposition?: string;
  /** The object's `Content-Encoding`. */
  contentEncoding?: string;
}

/** What `initiateMultipart` resolves with. */
export interface MultipartInitResult {
  /** ID of the upload, for `uploadPart`, `completeMultipart` and `abortMultipart`. */
  uploadId: string;
}

/** Options of `uploadPart`. */
export interface UploadPartParams extends BaseRequest {
  /** Key of the upload's object. */
  key: string;
  /** ID `initiateMultipart` returned. */
  uploadId: string;
  /** The part's position, an integer from 1 to 10000. */
  partNumber: number;
  /** The part's content. Every part but the last must be at least 5 MiB on AWS S3. */
  body: BodyInit | ReadableStream<Uint8Array> | null;
  /**
   * The body's size in bytes. Pass it with a `ReadableStream`. It is signed,
   * so it must be exact: a wrong length fails the request.
   */
  contentLength?: number;
}

/** What `uploadPart` resolves with. Pass both on to `completeMultipart`. */
export interface UploadPartResult {
  /** The part's ETag, quoted (`"abc123"`). */
  etag: string;
  /** The part's checksum, when the client has a checksum algorithm configured. */
  checksum?: string;
}

/** Options of `completeMultipart`. */
export interface CompleteMultipartParams
  extends BaseRequest, Pick<ConditionalHeaders, "ifMatch" | "ifNoneMatch"> {
  /** Key of the upload's object. */
  key: string;
  /** ID `initiateMultipart` returned. */
  uploadId: string;
  /** Every uploaded part, in any order, as `uploadPart` resolved them. */
  parts: Array<{ partNumber: number; etag: string; checksum?: string }>;
}

/** What `completeMultipart` resolves with. */
export interface CompleteMultipartResult {
  /** The object's ETag, quoted (`"abc123-2"`). */
  etag: string;
  /** URL of the object, when the store reports one. */
  location?: string;
}

/** Options of `abortMultipart`. */
export interface AbortMultipartParams extends BaseRequest {
  /** Key of the upload's object. */
  key: string;
  /** ID `initiateMultipart` returned. */
  uploadId: string;
}

/** Options of `list`. */
export interface ListObjectsV2Params extends BaseRequest {
  /** List only keys that start with this. */
  prefix?: string;
  /** Group keys up to this character into `commonPrefixes`, such as `"/"` for folders. */
  delimiter?: string;
  /** `nextContinuationToken` of the previous page. */
  continuationToken?: string;
  /** List only keys that sort after this one. */
  startAfter?: string;
  /** Most keys a page holds. Stores cap it, AWS S3 at 1000. */
  maxKeys?: number;
}

/** What `list` resolves with. */
export interface ListObjectsV2Response {
  /** The objects of this page. */
  contents: Array<{
    /** Object key. */
    key: string;
    /** Size in bytes. */
    size: number;
    /** ETag, quoted (`"abc123"`), when the store lists one. */
    etag: string | undefined;
    /** Time of the last change, in ISO 8601. */
    lastModified: string;
    /** Storage class, such as `"STANDARD"`. */
    storageClass?: string;
  }>;
  /** Keys grouped up to the `delimiter`, such as `"photos/"`. */
  commonPrefixes: string[];
  /** Whether more pages follow. */
  isTruncated: boolean;
  /** Pass it as `continuationToken` for the next page. */
  nextContinuationToken?: string;
  /**
   * Where the next page starts on a store that pages the older (V1) way, with
   * no continuation token. Pass it as `query: { marker }`, not as
   * `continuationToken`.
   */
  nextMarker?: string;
}

/** The HTTP methods a presigned URL can authorize. */
export type PresignMethod = "GET" | "PUT" | "HEAD" | "DELETE";

/** Options of `getSignedUrl`. */
export interface PresignParams extends BaseRequest {
  /** The method the URL authorizes. */
  method: PresignMethod;
  /**
   * How long the URL stays valid, in seconds: an integer from 1 to 604800
   * (seven days).
   *
   * @default 900
   */
  expiresInSeconds?: number;
}

/**
 * File extensions, without the dot, mapped to their media types.
 *
 * @example
 * ```ts
 * const table: MimeTable = { heic: "image/heic", glb: "model/gltf-binary" };
 * ```
 */
export type MimeTable = Readonly<Record<string, string>>;

/**
 * Infers a content type from an object key. It gets the caller's explicit type
 * too: a string to keep, or `false` for none. Returning `undefined` sends no
 * content type.
 */
export type ContentTypeResolver = (key: string, explicit?: string | false) => string | undefined;
