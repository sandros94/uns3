import {
  DISALLOWED_ERROR_HEADERS,
  buildRequestUrl,
  applyQuery,
  createHeaders,
  defaultContentTypeResolver,
  finalizeQuery,
  presignUrl,
  resolveContentType,
  send,
  signRequest,
  isPayloadStream,
} from "./core.ts";
import type {
  Methods,
  ContentTypeResolver,
  Credentials,
  AbortMultipartParams,
  CompleteMultipartParams,
  CompleteMultipartResult,
  DeleteObjectParams,
  GetObjectParams,
  HeadObjectParams,
  ListObjectsV2Params,
  ListObjectsV2Response,
  MultipartInitParams,
  MultipartInitResult,
  BaseRequest,
  ObjectRequest,
  PresignParams,
  PutObjectParams,
  S3ClientConfig,
  RetryConfig,
  ChecksumConfig,
  UploadPartParams,
  UploadPartResult,
} from "./types.ts";
import { S3Error } from "./error.ts";
import {
  isArrayBuffer,
  isArrayBufferView,
  isBlob,
  isPlainObject,
  isReadableStream,
} from "./utils.ts";

interface RequestOptions {
  /** Whether the request moves object bytes, which gives it no default deadline. */
  movesBytes: boolean;
  body?: BodyInit | ReadableStream<Uint8Array> | null;
  contentLength?: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  expectedStatus: number | number[];
}

interface PerformContext {
  method: Methods;
  url: URL;
  headers: Headers;
  body?: BodyInit | ReadableStream<Uint8Array> | null;
  bucket: string;
  key: string | undefined;
  expectedStatus: number | number[];
  signal?: AbortSignal;
  /** The deadline of each attempt, up to the response it is answered with. */
  timeoutMs: number | false;
}

const DEFAULT_RETRY_CONFIG: Required<Omit<RetryConfig, "retriable">> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 20_000,
  jitter: true,
};

/** The default deadline of an attempt that moves no object bytes, and of reading an error body. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The longest delay `setTimeout` keeps: anything larger fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const MAX_INLINE_CHECKSUM_BYTES = 16 * 1024 * 1024;

/**
 * How far the endpoint's clock has to be from the one already in use before the
 * client starts signing with the endpoint's instead. See `updateClockSkew`.
 */
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * High-level S3 interface that speaks the REST protocol with SigV4 signing
 * while remaining runtime agnostic. The client never buffers response bodies
 * implicitly and relies entirely on Fetch/Web Crypto primitives.
 */
export class S3Client {
  private readonly region: string;
  private readonly endpoint: string;
  private readonly bucketStyle: NonNullable<S3ClientConfig["bucketStyle"]>;
  private readonly fetcher: typeof fetch;
  private readonly credentials: S3ClientConfig["credentials"];
  private readonly defaultBucket?: string;
  private readonly contentTypeResolver: ContentTypeResolver;
  private readonly checksumConfig: ChecksumConfig;
  private clockSkewMs: number;
  private readonly timeoutMs: number | false;
  private readonly retryConfig: Required<Omit<RetryConfig, "retriable">> &
    Pick<RetryConfig, "retriable">;

  /**
   * Creates a new client instance.
   *
   * @param config - Connection, credential, and runtime overrides for S3.
   */
  constructor(config: S3ClientConfig) {
    this.region = config.region ?? "auto";
    this.endpoint = config.endpoint;
    this.bucketStyle = config.bucketStyle ?? "virtual";
    this.credentials = config.credentials;
    this.defaultBucket = config.defaultBucket;
    this.fetcher = config.fetch ?? globalFetch() ?? missingFetch();
    this.contentTypeResolver = config.contentTypeResolver ?? defaultContentTypeResolver;
    this.checksumConfig = config.checksum ? { ...config.checksum } : { algorithm: "none" };
    this.retryConfig = normalizeRetryConfig(config.retry);
    this.timeoutMs = normalizeTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.clockSkewMs = normalizeClockSkew(config.clockSkewMs ?? 0);
  }

  /**
   * Executes a GET Object request and returns the raw {@link Response}. For
   * streamed consumption read {@link Response.body}, which this client never
   * buffers on your behalf.
   *
   * Supports conditional requests via `ifMatch`, `ifNoneMatch`, `ifModifiedSince`,
   * and `ifUnmodifiedSince`. When the object hasn't changed, S3 may return a
   * `304 Not Modified` response with no body, which is treated as success.
   *
   * Accepts `200`, `206`, and `304` by default — `206 Partial Content` because a
   * `range` makes it the correct answer. Set `expectedStatus` to replace that
   * list entirely.
   *
   * @param params - Request configuration including bucket and key.
   * @example
   * ```ts
   * const response = await client.get({ bucket: "my-bucket", key: "hello.txt" });
   * const text = await response.text();
   * ```
   */
  async get(params: GetObjectParams): Promise<Response> {
    return await this.execute("GET", params, {
      movesBytes: true,
      expectedStatus: params.expectedStatus ?? [200, 206, 304],
    });
  }

  /**
   * Issues a HEAD Object call returning metadata-only responses.
   *
   * Supports conditional requests via `ifMatch`, `ifNoneMatch`, `ifModifiedSince`,
   * and `ifUnmodifiedSince`. When the object hasn't changed, S3 may return a
   * `304 Not Modified` response, which is treated as success.
   *
   * Accepts `200`, `206`, and `304` by default — a ranged HEAD answers `206` for
   * the same reason a ranged GET does. Set `expectedStatus` to replace that list
   * entirely.
   *
   * @param params - Request configuration including bucket and key.
   * @example
   * ```ts
   * const response = await client.head({ bucket: "my-bucket", key: "hello.txt" });
   * const exists = response.status === 200;
   * ```
   */
  async head(params: HeadObjectParams): Promise<Response> {
    return await this.execute("HEAD", params, {
      movesBytes: false,
      expectedStatus: params.expectedStatus ?? [200, 206, 304],
    });
  }

  /**
   * Uploads an object using PUT semantics. The content type is the caller's
   * `contentType`, else a `content-type` header, else the body's own type,
   * and only then inferred from the key by the configured resolver.
   *
   * Supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for conditional
   * overwrites. Note that not all S3-compatible providers support these headers.
   * When a condition fails, the `412 Precondition Failed` is raised as an
   * {@link S3Error}.
   *
   * Accepts `200` by default. Set `expectedStatus` to replace that list
   * entirely — stores that answer `201` to a PUT need it.
   *
   * `contentLength` declares the body's size, and is what makes a streamed
   * upload work everywhere: a stream with no length goes out as
   * `Transfer-Encoding: chunked`, which RustFS and AWS S3 refuse with `411
   * MissingContentLength`, while a declared length is sent fixed-length
   * instead. It is signed along with everything else, so a value that does not
   * match the body is not a rounding error: the request is either rejected for
   * a bad signature or hangs and surfaces as a bare `fetch failed`. Pass the
   * byte length of the body or nothing at all.
   *
   * @param params - Upload configuration including payload and metadata.
   * @example
   * ```ts
   * await client.put({ bucket: "my-bucket", key: "hello.txt", body: "Hello, world!" });
   * ```
   */
  async put(params: PutObjectParams): Promise<Response> {
    let body: BodyInit | ReadableStream<Uint8Array> | null;
    let ownType: string | undefined;

    if (isPlainObject(params.body)) {
      body = JSON.stringify(params.body);
      ownType = "application/json";
    } else if (isBodyInit(params.body)) {
      body = params.body;
      ownType = isBlob(body) ? body.type : undefined;
    } else {
      throw new TypeError(
        "put() takes a string, Blob, ArrayBuffer, typed array, ReadableStream, FormData, URLSearchParams, plain object or array as its body.",
      );
    }

    if (params.contentType === false) {
      body = withoutImplicitType(body);
    }

    const resolvedContentType = this.chooseContentType(params, ownType);
    return await this.execute("PUT", params, {
      movesBytes: true,
      body,
      contentLength: params.contentLength,
      contentType: resolvedContentType,
      cacheControl: params.cacheControl,
      contentDisposition: params.contentDisposition,
      contentEncoding: params.contentEncoding,
      expectedStatus: params.expectedStatus ?? 200,
    });
  }

  /**
   * Deletes an object. Treats both 200 and 204 responses as success; set
   * `expectedStatus` to replace that list entirely.
   *
   * @param params - Request configuration including bucket and key.
   * @example
   * ```ts
   * await client.del({ bucket: "my-bucket", key: "hello.txt" });
   * ```
   */
  async del(params: DeleteObjectParams): Promise<Response> {
    return await this.execute("DELETE", params, {
      movesBytes: false,
      expectedStatus: params.expectedStatus ?? [200, 204],
    });
  }

  /**
   * Lists objects using the ListObjectsV2 API and parses a convenient result
   * structure for contents and common prefixes.
   *
   * Pagination follows `nextContinuationToken` while `isTruncated` is `true`.
   * A store that ignores `list-type=2` and answers V1-style instead reports
   * `nextMarker` and no token; that value goes back as `query: { marker }`, not
   * as `continuationToken` — see {@link ListObjectsV2Response.nextMarker}.
   *
   * Every entry the store lists is returned, and a listing that cannot be read
   * is raised as an {@link S3Error} rather than trimmed. A listing the store
   * url-encoded (`query: { "encoding-type": "url" }`) is decoded, so keys read
   * the same either way. Typed parameters replace any namesake in `query`.
   *
   * @param params - Listing options such as prefix, delimiter, and pagination.
   * @example
   * ```ts
   * const result = await client.list({ bucket: "my-bucket", prefix: "uploads/" });
   * for (const obj of result.contents) {
   *   console.log(obj.key, obj.size);
   * }
   * ```
   */
  async list(params: ListObjectsV2Params = {}): Promise<ListObjectsV2Response> {
    const bucket = this.resolveBucket(params.bucket);
    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key: "",
    });

    const headers = createHeaders({ headers: params.headers });

    /* The caller's query first, then every typed parameter replacing its namesake. */
    applyQuery(url, params.query);
    const query = url.searchParams;
    query.set("list-type", "2");
    if (params.prefix) query.set("prefix", params.prefix);
    if (params.delimiter) query.set("delimiter", params.delimiter);
    if (params.continuationToken) query.set("continuation-token", params.continuationToken);
    if (params.startAfter) query.set("start-after", params.startAfter);
    if (typeof params.maxKeys === "number") query.set("max-keys", String(params.maxKeys));

    return await this.performXml(
      {
        method: "GET",
        url,
        headers,
        bucket,
        key: undefined,
        expectedStatus: params.expectedStatus ?? 200,
        signal: params.signal,
        timeoutMs: this.deadline(params, false),
      },
      "ListBucketResult",
      parseListObjectsV2,
    );
  }

  /**
   * Generates a SigV4 presigned URL for the provided method and object key.
   *
   * Purely local: nothing is sent, so `expectedStatus` and `signal` have no
   * effect here — whoever later fetches the URL owns the response.
   *
   * @param params - Method, bucket/key, expiry, and optional overrides.
   * @throws {RangeError} When `expiresInSeconds` is not an integer from 1 to 604800.
   * @example
   * ```ts
   * const url = await client.getSignedUrl({
   *   method: "GET",
   *   bucket: "my-bucket",
   *   key: "hello.txt",
   *   expiresInSeconds: 3600,
   * });
   * ```
   */
  async getSignedUrl(params: PresignParams): Promise<string> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    applyQuery(url, params.query);

    const headers = createHeaders({ headers: params.headers });
    const credentials = await this.resolveCredentials();

    if (!credentials) {
      throw new Error("Cannot generate presigned URL without credentials.");
    }

    const result = await presignUrl({
      method: params.method,
      url,
      headers,
      credentials,
      region: this.region,
      datetime: this.createSigningDate(),
      expiresInSeconds: params.expiresInSeconds,
    });

    return result.url.toString();
  }

  /**
   * Starts a multipart upload and returns an upload ID for use with
   * {@link uploadPart} and {@link completeMultipart}.
   *
   * @param params - Multipart initiation options including bucket, key, and optional metadata.
   * @example
   * ```ts
   * const { uploadId } = await client.initiateMultipart({
   *   bucket: "my-bucket",
   *   key: "large-file.bin",
   * });
   * ```
   */
  async initiateMultipart(params: MultipartInitParams): Promise<MultipartInitResult> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const contentType = this.chooseContentType(params, undefined);
    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    applyQuery(url, params.query);
    url.searchParams.set("uploads", "");

    const headers = createHeaders({
      headers: params.headers,
      contentType,
      cacheControl: params.cacheControl,
      contentDisposition: params.contentDisposition,
      contentEncoding: params.contentEncoding,
    });

    /*
     * Declared only when every part is bound to carry a checksum: a store holds
     * an upload that declared one to it, and a part sent without (a stream the
     * client could not hash) would be refused.
     */
    const { algorithm, requireOnPut } = this.checksumConfig;
    if (algorithm !== "none" && requireOnPut && !headers.has("x-amz-checksum-algorithm")) {
      headers.set("x-amz-checksum-algorithm", algorithm.toUpperCase());
    }

    const uploadId = await this.performXml(
      {
        method: "POST",
        url,
        headers,
        bucket,
        key,
        expectedStatus: params.expectedStatus ?? 200,
        signal: params.signal,
        timeoutMs: this.deadline(params, false),
      },
      "InitiateMultipartUploadResult",
      (text) => requiredTag(text, "UploadId"),
    );

    return { uploadId };
  }

  /**
   * Uploads a single part of a multipart upload. Returns the ETag required
   * by {@link completeMultipart} to assemble the final object.
   *
   * The part body is a payload like any other, so a configured `checksum`
   * applies to it exactly as it does to {@link put}: the header is computed and
   * signed when the body can be buffered, and with `requireOnPut` a body that
   * cannot be — a stream, or one over 16 MiB — is refused rather than sent
   * unchecked.
   *
   * `contentLength` is a hint for stores that demand an explicit
   * `Content-Length`, and it is signed along with everything else. A value that
   * does not match the body is therefore not a rounding error: the request is
   * either rejected for a bad signature or hangs and surfaces as a bare
   * `fetch failed`. Pass the byte length of the body or nothing at all.
   *
   * @param params - Part upload options including uploadId, partNumber, and body.
   * @example
   * ```ts
   * const { etag } = await client.uploadPart({
   *   bucket: "my-bucket",
   *   key: "large-file.bin",
   *   uploadId: "abc123",
   *   partNumber: 1,
   *   body: chunk,
   * });
   * ```
   */
  async uploadPart(params: UploadPartParams): Promise<UploadPartResult> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const uploadId = validateUploadId(params.uploadId);
    const partNumber = normalizePartNumber(params.partNumber);

    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    applyQuery(url, params.query);
    url.searchParams.set("uploadId", uploadId);
    url.searchParams.set("partNumber", String(partNumber));

    const headers = createHeaders({ headers: params.headers });
    if (typeof params.contentLength === "number") {
      headers.set("content-length", String(params.contentLength));
    }

    /* Applied before signing, so the header the store validates is one the signature covers. */
    const body = await materializeBody(params.body);
    await this.applyChecksum(body, headers);

    const response = await this.perform({
      method: "PUT",
      url,
      headers,
      body,
      bucket,
      key,
      expectedStatus: params.expectedStatus ?? 200,
      signal: params.signal,
      timeoutMs: this.deadline(params, true),
    });

    const etagHeader = response.headers.get("etag");
    discardBody(response);

    if (!etagHeader) {
      throw errorFrom(response, undefined, {
        message: "The UploadPart response carries no ETag.",
        retriable: false,
      });
    }

    const { algorithm } = this.checksumConfig;
    const checksum =
      algorithm === "none" ? undefined : response.headers.get(checksumHeader(algorithm));
    return checksum
      ? { etag: ensureQuotedEtag(etagHeader), checksum }
      : { etag: ensureQuotedEtag(etagHeader) };
  }

  /**
   * Completes a multipart upload by assembling previously uploaded parts.
   *
   * Supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for conditional
   * overwrites. Note that not all S3-compatible providers support these headers.
   * When a condition fails, the `412 Precondition Failed` is raised as an
   * {@link S3Error}.
   *
   * S3 can report a failure inside a `200` on this call, so the response body is
   * read before anything is believed. An error found there is raised like any
   * other, and retried when it is transient.
   *
   * @param params - Configuration for completing the multipart upload.
   * @example
   * ```ts
   * const { etag } = await client.completeMultipart({
   *   bucket: "my-bucket",
   *   key: "large-file.bin",
   *   uploadId: "abc123",
   *   parts: [
   *     { partNumber: 1, etag: "etag1" },
   *     { partNumber: 2, etag: "etag2" },
   *   ],
   * });
   * ```
   */
  async completeMultipart(params: CompleteMultipartParams): Promise<CompleteMultipartResult> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const uploadId = validateUploadId(params.uploadId);
    const parts = normalizeCompletedParts(params.parts);
    const payload = buildCompleteMultipartXml(parts, this.checksumConfig.algorithm);

    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    applyQuery(url, params.query);
    url.searchParams.set("uploadId", uploadId);

    const headers = createHeaders({
      headers: params.headers,
      ifMatch: params.ifMatch,
      ifNoneMatch: params.ifNoneMatch,
      contentType: "application/xml",
    });

    return await this.performXml(
      {
        method: "POST",
        url,
        headers,
        body: payload,
        bucket,
        key,
        expectedStatus: params.expectedStatus ?? 200,
        signal: params.signal,
        timeoutMs: this.deadline(params, false),
      },
      "CompleteMultipartUploadResult",
      (text) => ({
        etag: ensureQuotedEtag(requiredTag(text, "ETag")),
        location: extractTag(text, "Location") || undefined,
      }),
    );
  }

  /**
   * Cancels an in-progress multipart upload, freeing any already-uploaded parts
   * on the server.
   *
   * @param params - Abort options including bucket, key, and uploadId.
   * @example
   * ```ts
   * await client.abortMultipart({
   *   bucket: "my-bucket",
   *   key: "large-file.bin",
   *   uploadId: "abc123",
   * });
   * ```
   */
  async abortMultipart(params: AbortMultipartParams): Promise<void> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const uploadId = validateUploadId(params.uploadId);

    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    applyQuery(url, params.query);
    url.searchParams.set("uploadId", uploadId);

    const headers = createHeaders({ headers: params.headers });

    const response = await this.perform({
      method: "DELETE",
      url,
      headers,
      bucket,
      key,
      expectedStatus: params.expectedStatus ?? [200, 202, 204],
      signal: params.signal,
      timeoutMs: this.deadline(params, false),
    });

    discardBody(response);
  }

  private async execute(
    method: Methods,
    params: ObjectRequest,
    options: RequestOptions,
  ): Promise<Response> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    const headers = createHeaders({
      headers: params.headers,
      contentType: options.contentType,
      cacheControl: options.cacheControl,
      contentDisposition: options.contentDisposition,
      contentEncoding: options.contentEncoding,
      range: params.range,
      ifMatch: params.ifMatch,
      ifNoneMatch: params.ifNoneMatch,
      ifModifiedSince: params.ifModifiedSince,
      ifUnmodifiedSince: params.ifUnmodifiedSince,
    });

    /*
     * Applied here, before signing, so the length the store reads is one the
     * signature covers — the same placement, and the same reasoning, as
     * `uploadPart`.
     */
    if (typeof options.contentLength === "number") {
      headers.set("content-length", String(options.contentLength));
    }

    if (params.query) {
      applyQuery(url, params.query);
    }

    const body = await materializeBody(options.body);
    if (method === "PUT") await this.applyChecksum(body, headers);

    const response = await this.perform({
      method,
      url,
      headers,
      body,
      bucket,
      key,
      expectedStatus: options.expectedStatus,
      signal: params.signal,
      timeoutMs: this.deadline(params, options.movesBytes),
    });

    return response;
  }

  /**
   * The deadline of each attempt of a request. One that moves object bytes has
   * none unless the caller sets one, since a large transfer has no honest
   * default. Every other request gets the client's.
   */
  private deadline(params: BaseRequest, movesBytes: boolean): number | false {
    if (params.timeoutMs !== undefined) {
      return normalizeTimeout(params.timeoutMs, "timeoutMs");
    }
    return movesBytes ? false : this.timeoutMs;
  }

  private async perform(context: PerformContext): Promise<Response> {
    return await this.exchange(context, async (response) => response);
  }

  /**
   * Sends a request whose answer is an XML document, and returns what `read`
   * makes of it once it is known to be the one asked for: its root element is
   * `root`, and `read` finds everything it needs in it.
   *
   * Anything else is a failure of the attempt, retried like one. An `<Error>`
   * document is the failure it reports, whatever the status that carried it.
   */
  private async performXml<T>(
    context: PerformContext,
    root: string,
    read: (text: string) => T,
  ): Promise<T> {
    return await this.exchange(context, async (response) => {
      const text = await response.text();
      const actual = xmlRoot(text);
      if (actual === "Error") {
        throw buildError(response, text);
      }
      if (actual !== root) {
        throw invalidResponse(
          response,
          text,
          text.trim()
            ? `Expected a <${root}> document, got ${actual ? `<${actual}>` : "something that is not XML"}.`
            : `Expected a <${root}> document, got an empty body.`,
        );
      }
      try {
        return read(text);
      } catch (error) {
        if (error instanceof MalformedXml) {
          throw invalidResponse(response, text, `The <${root}> document ${error.message}.`);
        }
        throw error;
      }
    });
  }

  private async exchange<T>(
    context: PerformContext,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const credentials = await this.resolveCredentials();
    const unsignedPayload = shouldUseUnsignedPayload(context.method, context.body);
    /*
     * The query is re-encoded once, before the first signature: from here on the
     * bytes on the wire are the bytes the signer canonicalizes. Running it later
     * or twice would be harmless — decode-then-encode is a round trip — but
     * every parameter is already in place by now.
     */
    finalizeQuery(context.url);
    const streamedBody = hasBody(context.method) && isPayloadStream(context.body ?? null);
    if (streamedBody && stringifiesStreamBodies()) {
      throw new TypeError(
        "This runtime cannot send a ReadableStream as a request body, and would send its string form instead. Pass a Blob, ArrayBuffer or Uint8Array.",
      );
    }
    const { maxAttempts } = this.retryConfig;

    for (let attempt = 1; ; attempt += 1) {
      let headers = context.headers;
      const abort = attemptAbort(context.signal);

      if (credentials) {
        const result = await signRequest({
          method: context.method,
          url: context.url,
          headers: context.headers,
          body: context.body,
          credentials,
          region: this.region,
          unsignedPayload,
          datetime: this.createSigningDate(),
        });
        headers = result.headers;
        /* The payload is hashed once: every later attempt signs the same hash. */
        context.headers.set("x-amz-content-sha256", result.payloadHash);
      }

      const init: RequestInit = {
        method: context.method,
        headers,
        body: hasBody(context.method) ? (context.body ?? null) : undefined,
        signal: abort.signal,
        /*
         * A redirect is never followed. Following one sends the request to a
         * host it was not signed for, stripped of its `Authorization`, and the
         * caller gets that host's refusal instead of the region the store named.
         */
        redirect: "manual",
      };

      if (streamedBody) {
        /*
         * Required by the Fetch standard whenever the body is a stream, and
         * enforced by undici, Deno, Bun and workerd alike: without it the
         * `Request` constructor throws `duplex option is required` and nothing
         * is ever sent. Set only for a stream body — it is invalid otherwise —
         * and cast narrowly because the option is still missing from some
         * `RequestInit` typings.
         */
        (init as RequestInit & { duplex: "half" }).duplex = "half";
      }

      const request = new Request(context.url.toString(), init);

      /*
       * One attempt ends in exactly one of two ways: a response the caller
       * expected, or a failure — an unexpected response turned into an
       * `S3Error`, or whatever the transport threw. The retry decision is made
       * once, below, about that one failure.
       */
      let response: Response | undefined;
      let failure: unknown;
      try {
        abort.arm(context.timeoutMs);
        ({ response } = await send({ request, signal: abort.signal }, this.fetcher));

        this.updateClockSkew(response);

        if (matchesExpected(response.status, context.expectedStatus)) {
          const value = await read(response);
          /*
           * The deadline stops at the response. A body the caller reads later
           * is theirs to bound, and only their own signal still reaches it.
           */
          abort.disarm();
          return value;
        }

        /* An error body is bounded whatever the request, since nobody else reads it. */
        if (!abort.armed) abort.arm(this.timeoutMs);
        failure = await createError(response);
        discardBody(response);
      } catch (error) {
        failure = error;
      }
      abort.release();

      /*
       * The caller's signal is the only abort that ends the request outright,
       * and it ends it with the caller's own reason, whatever that is. An abort
       * the transport raised for its own reasons is a failed attempt like any
       * other.
       */
      context.signal?.throwIfAborted();

      if (!this.shouldRetry(streamedBody, response, failure, attempt, maxAttempts)) {
        throw failure instanceof S3Error ? failure : transportError(context, attempt, failure);
      }

      let delayMs = this.computeBackoffDelay(attempt);
      if (failure instanceof S3Error && typeof failure.retryAfter === "number") {
        delayMs = Math.max(delayMs, Math.ceil(failure.retryAfter * 1000));
      }
      delayMs = Math.min(delayMs, this.retryConfig.maxDelayMs);
      if (delayMs > 0) {
        await this.delay(delayMs, context.signal);
      }
    }
  }

  /**
   * The content type to set, or `undefined` to set none. The caller's own word
   * comes first: the `contentType` parameter, then a `content-type` header,
   * then the type the body carries. Only when none of them says anything is
   * one inferred from the key. `contentType: false` sets none at all.
   */
  private chooseContentType(
    params: { key: string; contentType?: string | false; headers?: HeadersInit },
    ownType: string | undefined,
  ): string | undefined {
    const { key, contentType } = params;
    if (contentType === false) return undefined;
    if (contentType !== undefined) {
      return resolveContentType(key, contentType, this.contentTypeResolver);
    }
    if (new Headers(params.headers).has("content-type")) return undefined;
    return ownType || resolveContentType(key, undefined, this.contentTypeResolver);
  }

  private resolveBucket(bucket: string | undefined): string {
    const resolved = bucket ?? this.defaultBucket;
    if (!resolved) {
      throw new Error("Bucket is required but was not provided.");
    }
    return resolved;
  }

  private resolveKey(params: { key?: string }): string {
    if (!params.key) {
      throw new Error("Key is required for this operation.");
    }
    return params.key;
  }

  private async resolveCredentials(): Promise<Credentials | undefined> {
    const value = this.credentials;
    if (!value) {
      return undefined;
    }

    const credentials = typeof value === "function" ? await value() : value;
    if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new Error("Invalid credentials resolved for S3Client.");
    }
    return credentials;
  }

  /*
   * WHICH REQUESTS CARRY A CHECKSUM, AND WHY THE REST DO NOT.
   *
   * `x-amz-checksum-*` states the integrity of an object payload, so it belongs
   * on the two calls that send one: `put` (through `execute`) and `uploadPart`.
   * The other methods that reach `perform` directly were each looked at rather
   * than wired up by reflex:
   *
   * - `list` is a GET with no body; there is nothing to checksum.
   * - `abortMultipart` is a DELETE with no body; likewise.
   * - `initiateMultipart` is a POST with an empty body. A checksum of nothing
   *   says nothing. The header S3 reads on this call is
   *   `x-amz-checksum-algorithm`, which DECLARES what the parts will use, and
   *   is sent when `requireOnPut` guarantees every part carries one.
   * - `completeMultipart` is a POST whose body is the parts manifest, but
   *   `x-amz-checksum-*` on that call is read as the composite checksum of the
   *   assembled OBJECT, not of the XML. Sending a digest of the manifest there
   *   would be a lie in a field that gets believed. Each part's own checksum
   *   goes in the manifest instead.
   *
   * A checksum header the caller already set is theirs, and is left alone.
   */
  private async applyChecksum(
    body: BodyInit | ReadableStream<Uint8Array> | null | undefined,
    headers: Headers,
  ): Promise<void> {
    const algorithm = this.checksumConfig.algorithm;
    if (algorithm === "none") {
      return;
    }
    for (const name of headers.keys()) {
      if (name.startsWith("x-amz-checksum-")) return;
    }

    const normalized = await normalizeBodyForChecksum(body, MAX_INLINE_CHECKSUM_BYTES);

    if (!("bytes" in normalized)) {
      if (this.checksumConfig.requireOnPut) {
        const reason = formatChecksumFailureReason(normalized.reason);
        throw new Error(`Unable to compute ${algorithm} checksum for PUT payload: ${reason}.`);
      }
      return;
    }

    const value =
      algorithm === "sha256"
        ? await computeSha256Base64(normalized.bytes)
        : computeCrc32cBase64(normalized.bytes);
    headers.set(checksumHeader(algorithm), value);
  }

  private createSigningDate(): Date {
    return new Date(Date.now() + this.clockSkewMs);
  }

  /**
   * Adopts the endpoint's clock, but only when the difference is big enough to
   * be one.
   *
   * Only a real response reaches here — a `fetch` that never completed throws
   * long before, so a dead connection or a DNS failure cannot move the signing
   * clock. Of the responses that do arrive, a `Date` header is a second-
   * resolution stamp of when the answer was generated, not when it landed, so
   * some difference is always measured and adopting each one made the clock
   * wander for no reason. Worse, any intermediary that answers at all — a
   * proxy, a captive portal, an error page — could shift every later signature.
   *
   * The threshold is AWS's own rule: a signature is valid for fifteen minutes,
   * corrections start at five, and anything under that is latency rather than
   * skew. It is measured against the clock already in use, not the raw local
   * one, which is what lets a correction be dropped again once the local clock
   * is the thing that gets fixed.
   */
  private updateClockSkew(response: Response): void {
    const dateHeader = response.headers.get("date");
    if (!dateHeader) {
      return;
    }
    const parsed = Date.parse(dateHeader);
    if (Number.isNaN(parsed)) {
      return;
    }
    const skew = parsed - Date.now();
    if (Math.abs(skew - this.clockSkewMs) < CLOCK_SKEW_THRESHOLD_MS) {
      return;
    }
    this.clockSkewMs = normalizeClockSkew(skew);
  }

  private shouldRetry(
    bodyIsStream: boolean,
    response: Response | undefined,
    error: unknown,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (attempt >= maxAttempts) {
      return false;
    }

    /*
     * A stream body is spent by the attempt that sent it — there is nothing
     * left to put in a second request, and building one would fail with a "body
     * already used" `TypeError` that buries the error actually worth reporting.
     * This sits ahead of `retriable` deliberately: the predicate decides policy,
     * and a consumed body is not policy.
     */
    if (bodyIsStream) {
      return false;
    }

    const custom = this.retryConfig.retriable;
    if (custom) {
      try {
        return Boolean(custom(response, error));
      } catch {
        return false;
      }
    }

    /*
     * Eligibility is about the body, not the method: every operation the
     * client issues is safe to repeat once its body can be sent again, which
     * the stream check above already settled. What remains is whether the
     * failure is transient — a response says so through its status and code,
     * and a request that never got one failed in transit.
     */
    if (response) {
      return error instanceof S3Error ? error.retriable : isRetriableStatus(response.status);
    }
    return true;
  }

  private computeBackoffDelay(attempt: number): number {
    const base = this.retryConfig.baseDelayMs;
    if (base <= 0) {
      return 0;
    }
    const exponent = Math.max(0, attempt - 1);
    const raw = base * 2 ** exponent;
    if (this.retryConfig.jitter === false) {
      return raw;
    }
    const min = Math.floor(raw / 2);
    const range = Math.max(raw - min, 0);
    return min + Math.floor(Math.random() * (range + 1));
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
      return;
    }
    if (!signal) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
      return;
    }

    const abortSignal = signal;

    await new Promise<void>((resolve, reject) => {
      if (abortSignal.aborted) {
        reject(abortSignal.reason);
        return;
      }

      function cleanup(): void {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
      }

      function onAbort(): void {
        cleanup();
        reject(abortSignal.reason);
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      abortSignal.addEventListener("abort", onAbort);
    });
  }
}

// #region Internal

type ChecksumFailureReason = "stream" | "too-large" | "unsupported";
type ChecksumNormalizationResult =
  | { bytes: Uint8Array; size: number }
  | { reason: ChecksumFailureReason };
type ChecksumAlgorithm = Exclude<ChecksumConfig["algorithm"], "none">;

const textEncoder = new TextEncoder();
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CRC32C_INITIAL = 4_294_967_295;
const CRC32C_POLY = 2_197_175_160;
const CRC32C_TABLE = createCrc32cTable();
const RETRIABLE_ERROR_CODES = new Set<string>([
  "SLOWDOWN",
  "THROTTLING",
  "THROTTLINGEXCEPTION",
  "REQUESTTIMEOUT",
  "REQUESTTIMEOUTEXCEPTION",
  "REQUESTTIMETOOSKEWED",
  "INTERNALERROR",
  "SERVICEUNAVAILABLE",
  "SERVICEUNAVAILABLEEXCEPTION",
  "HTTP503",
  "GATEWAYTIMEOUT",
  "CONDITIONALREQUESTCONFLICT",
]);

async function normalizeBodyForChecksum(
  body: BodyInit | ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<ChecksumNormalizationResult> {
  if (body === undefined || body === null) {
    return { bytes: new Uint8Array(0), size: 0 };
  }

  if (typeof body === "string") {
    const bytes = textEncoder.encode(body);
    if (bytes.byteLength > maxBytes) {
      return { reason: "too-large" };
    }
    return { bytes, size: bytes.byteLength };
  }

  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) {
      return { reason: "too-large" };
    }
    return { bytes: new Uint8Array(body), size: body.byteLength };
  }

  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (view.byteLength > maxBytes) {
      return { reason: "too-large" };
    }
    return { bytes: view, size: view.byteLength };
  }

  if (isBlob(body)) {
    /* Only a Blob too large to hold is still a Blob here. */
    return { reason: "too-large" };
  }

  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return { reason: "stream" };
  }

  return { reason: "unsupported" };
}

function formatChecksumFailureReason(reason: ChecksumFailureReason): string {
  switch (reason) {
    case "stream": {
      return "body is a stream and cannot be buffered without consuming it";
    }
    case "too-large": {
      return `body exceeds ${MAX_INLINE_CHECKSUM_BYTES} bytes`;
    }
    default: {
      return "body type is not supported for checksum calculation";
    }
  }
}

function checksumHeader(algorithm: ChecksumAlgorithm): string {
  return `x-amz-checksum-${algorithm}`;
}

/**
 * A Blob small enough to hold, read into memory once. Every attempt then
 * re-sends, hashes and checksums the same bytes rather than reading the Blob
 * again. A larger Blob is left as it is and signed `UNSIGNED-PAYLOAD`.
 */
async function materializeBody(
  body: BodyInit | ReadableStream<Uint8Array> | null | undefined,
): Promise<BodyInit | ReadableStream<Uint8Array> | null | undefined> {
  if (isBlob(body) && body.size <= MAX_INLINE_CHECKSUM_BYTES) {
    return new Uint8Array(await body.arrayBuffer());
  }
  return body;
}

async function computeSha256Base64(data: Uint8Array): Promise<string> {
  const view =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data
      : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as BufferSource);
  return toBase64(new Uint8Array(digest));
}

function computeCrc32cBase64(data: Uint8Array): string {
  const checksum = crc32c(data);
  const bytes = new Uint8Array(4);
  bytes[0] = (checksum >>> 24) & 0xff;
  bytes[1] = (checksum >>> 16) & 0xff;
  bytes[2] = (checksum >>> 8) & 0xff;
  bytes[3] = checksum & 0xff;
  return toBase64(bytes);
}

function crc32c(data: Uint8Array): number {
  let crc = CRC32C_INITIAL;
  for (let index = 0; index < data.length; index += 1) {
    const tableIndex = (crc ^ data[index]!) & 0xff;
    crc = (crc >>> 8) ^ CRC32C_TABLE[tableIndex]!;
  }
  return (crc ^ CRC32C_INITIAL) >>> 0;
}

function createCrc32cTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      if ((crc & 1) === 1) {
        crc = (crc >>> 1) ^ CRC32C_POLY;
      } else {
        crc >>>= 1;
      }
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function toBase64(data: Uint8Array): string {
  let output = "";
  let position = 0;

  while (position < data.length) {
    const byte1 = data[position++]!;
    const hasByte2 = position < data.length;
    const byte2 = hasByte2 ? data[position++]! : 0;
    const hasByte3 = position < data.length;
    const byte3 = hasByte3 ? data[position++]! : 0;

    const chunk = (byte1 << 16) | (byte2 << 8) | byte3;

    output += BASE64_ALPHABET[(chunk >> 18) & 0x3f]!;
    output += BASE64_ALPHABET[(chunk >> 12) & 0x3f]!;
    output += hasByte2 ? BASE64_ALPHABET[(chunk >> 6) & 0x3f]! : "=";
    output += hasByte3 ? BASE64_ALPHABET[chunk & 0x3f]! : "=";
  }

  return output;
}

function determineErrorRetriable(status: number, code?: string): boolean {
  if (status === 429) {
    return true;
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return true;
  }
  if (!code) {
    return false;
  }
  const normalized = code.trim().toUpperCase();
  return RETRIABLE_ERROR_CODES.has(normalized);
}

/**
 * How long the store asked to be left alone, in seconds. `x-amz-retry-after`
 * counts milliseconds and wins. `Retry-After` is either whole seconds or an
 * HTTP date (RFC 9110, section 10.2.3), and anything else is ignored.
 */
function parseRetryAfter(headers: Headers): number | undefined {
  const amz = headers.get("x-amz-retry-after")?.trim();
  if (amz && /^\d+$/.test(amz)) {
    return Number(amz) / 1000;
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  if (!/[a-z]/i.test(value)) {
    return undefined;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function normalizeRetryConfig(
  retry: RetryConfig | undefined,
): Required<Omit<RetryConfig, "retriable">> & Pick<RetryConfig, "retriable"> {
  const merged = { ...DEFAULT_RETRY_CONFIG, ...retry };
  if (!Number.isSafeInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
    throw new RangeError(
      `retry.maxAttempts must be a positive integer, got ${String(merged.maxAttempts)}.`,
    );
  }
  if (!Number.isFinite(merged.baseDelayMs) || merged.baseDelayMs < 0) {
    throw new RangeError(
      `retry.baseDelayMs must be a finite number of zero or more, got ${String(merged.baseDelayMs)}.`,
    );
  }
  if (!(merged.maxDelayMs >= 0 && merged.maxDelayMs <= MAX_TIMER_MS)) {
    throw new RangeError(
      `retry.maxDelayMs must be between 0 and ${MAX_TIMER_MS}, got ${String(merged.maxDelayMs)}.`,
    );
  }
  return merged;
}

function normalizeTimeout(value: number | false, name: string): number | false {
  if (value === false) return false;
  if (!(value > 0 && value <= MAX_TIMER_MS)) {
    throw new RangeError(
      `${name} must be false or between 1 and ${MAX_TIMER_MS} milliseconds, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * The signal one attempt runs under. The caller's signal aborts it with the
 * caller's own reason, and `arm` starts a deadline that aborts it with a
 * `TimeoutError`. `release` lets go of both once the attempt has failed.
 */
function attemptAbort(caller: AbortSignal | undefined): {
  signal: AbortSignal;
  readonly armed: boolean;
  arm: (ms: number | false) => void;
  disarm: () => void;
  release: () => void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = (): void => controller.abort(caller?.reason);

  if (caller?.aborted) follow();
  else caller?.addEventListener("abort", follow, { once: true });

  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    signal: controller.signal,
    get armed() {
      return timer !== undefined;
    },
    arm(ms) {
      disarm();
      if (ms === false) return;
      timer = setTimeout(() => {
        controller.abort(new DOMException(`The attempt timed out after ${ms}ms.`, "TimeoutError"));
      }, ms);
    },
    disarm,
    release() {
      disarm();
      caller?.removeEventListener("abort", follow);
    },
  };
}

function normalizeClockSkew(skew: number): number {
  if (!Number.isFinite(skew)) {
    return 0;
  }
  return skew;
}

function isRetriableStatus(status: number): boolean {
  if (status === 429) {
    return true;
  }
  return status >= 500 && status !== 501 && status !== 505;
}

/**
 * Whether `fetch` sends a value as the bytes it holds. Anything else it sends
 * as its string form, `[object Map]` and the like.
 */
function isBodyInit(value: unknown): value is BodyInit | ReadableStream<Uint8Array> | null {
  return (
    value === null ||
    typeof value === "string" ||
    isBlob(value) ||
    isArrayBuffer(value) ||
    isArrayBufferView(value) ||
    isReadableStream(value) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams)
  );
}

/**
 * The same bytes, in a form `fetch` attaches no content type to: a string
 * would go out as `text/plain`, a typed Blob as its own type.
 */
function withoutImplicitType(
  body: BodyInit | ReadableStream<Uint8Array> | null,
): BodyInit | ReadableStream<Uint8Array> | null {
  if (typeof body === "string") return textEncoder.encode(body);
  if (isBlob(body) && body.type) return body.slice(0, body.size, "");
  return body;
}

let stringifiesStreams: boolean | undefined;

/**
 * Whether `fetch` would send a `ReadableStream` body as its string form,
 * detected once. A runtime that cannot take a stream as a body reads it as an
 * ordinary object, so it goes out as `[object ReadableStream]` with a
 * `text/plain` type, and a store accepts those bytes with a `200`. Firefox
 * is one such runtime. One that takes the stream but cannot upload it fails
 * the fetch loudly, which needs no guard.
 */
function stringifiesStreamBodies(): boolean {
  if (stringifiesStreams === undefined) {
    try {
      const init = { method: "POST", body: new ReadableStream(), duplex: "half" };
      stringifiesStreams = new Request("http://localhost/", init).headers.has("content-type");
    } catch {
      stringifiesStreams = false;
    }
  }
  return stringifiesStreams;
}

/**
 * Releases a response body nobody will read. A cancel that fails has nothing
 * left to clean up, so its rejection is dropped rather than left unhandled.
 */
function discardBody(response: Response): void {
  if (response.bodyUsed) return;
  response.body?.cancel().catch(() => {});
}

function matchesExpected(status: number, expected: number | number[]): boolean {
  if (Array.isArray(expected)) {
    return expected.includes(status);
  }
  return status === expected;
}

function hasBody(method: string): boolean {
  return method === "PUT" || method === "POST";
}

function shouldUseUnsignedPayload(
  method: string,
  body: BodyInit | ReadableStream<Uint8Array> | null | undefined,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return true;
  }
  if (!body) {
    return false;
  }
  /* A Blob still a Blob by now is one too large to hold, and a stream cannot be hashed. */
  return isBlob(body) || isPayloadStream(body as ReadableStream<Uint8Array>);
}

async function createError(response: Response): Promise<S3Error> {
  let text: string | undefined;
  try {
    text = await readErrorBody(response);
  } catch {
    /* A body that cannot be read leaves the status and headers to speak for it. */
  }
  return buildError(response, text);
}

/** An {@link S3Error} built from a response and the error document it carried, if any. */
function buildError(response: Response, text: string | undefined): S3Error {
  let message =
    response.type === "opaqueredirect"
      ? "The store answered with a redirect, which is never followed."
      : response.statusText || `HTTP ${response.status}`;
  let code: string | undefined;
  let resource: string | undefined;
  let region: string | undefined;

  /* Only an S3 error document is read: an HTML page's `<code>` is not an S3 code. */
  if (text && xmlRoot(text) === "Error") {
    const parsed = parseErrorXml(text);
    if (parsed.message) message = parsed.message;
    if (parsed.code) code = parsed.code;
    resource = parsed.resource;
    region = parsed.region;
  }

  return errorFrom(response, text, { message, code, resource, region });
}

/**
 * The S3 code a status stands for, for an error that came without a document
 * to name it — every `HEAD` among them.
 */
const STATUS_CODES: Record<number, string> = {
  301: "PermanentRedirect",
  304: "NotModified",
  307: "TemporaryRedirect",
  400: "BadRequest",
  403: "Forbidden",
  404: "NotFound",
  405: "MethodNotAllowed",
  409: "Conflict",
  412: "PreconditionFailed",
  416: "InvalidRange",
  500: "InternalError",
  501: "NotImplemented",
  503: "ServiceUnavailable",
};

/**
 * The error for a request that never got a response, naming the request
 * without its query, which can carry credentials, and keeping what failed it
 * as the cause.
 */
function transportError(context: PerformContext, attempts: number, cause: unknown): Error {
  const url = new URL(context.url);
  url.search = "";
  const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  return new Error(`${context.method} ${url.href} failed after ${tries}.`, { cause });
}

/**
 * An {@link S3Error} for a response whose status was fine but whose body was
 * not the document due. An empty body is retriable, since a connection cut
 * short leaves exactly that. Anything else is not.
 */
function invalidResponse(response: Response, text: string, message: string): S3Error {
  return errorFrom(response, text, { message, retriable: !text.trim() });
}

function errorFrom(
  response: Response,
  text: string | undefined,
  init: { message: string; code?: string; resource?: string; region?: string; retriable?: boolean },
): S3Error {
  const { message, resource, region } = init;
  const code = init.code ?? STATUS_CODES[response.status];
  const bucketRegion = response.headers.get("x-amz-bucket-region") ?? undefined;
  const retryAfter = parseRetryAfter(response.headers);
  const retriable = init.retriable ?? determineErrorRetriable(response.status, code);

  // Capture headers for debugging
  const headersRecord: Record<string, string> = {};
  // eslint-disable-next-line unicorn/no-array-for-each
  response.headers.forEach((value, key) => {
    if (DISALLOWED_ERROR_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headersRecord[key] = value;
  });

  return new S3Error({
    message,
    status: response.status,
    code,
    requestId: response.headers.get("x-amz-request-id") ?? undefined,
    extendedRequestId: response.headers.get("x-amz-id-2") ?? undefined,
    retriable,
    retryAfter,
    resource,
    region: region ?? bucketRegion,
    bucketRegion,
    cause: {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: headersRecord,
      body: text,
    },
  });
}

const textDecoder = new TextDecoder();
async function readErrorBody(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const limit = 64 * 1024;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      if (value.byteLength === 0) {
        continue;
      }
      if (total >= limit) {
        await reader.cancel();
        break;
      }
      const remaining = limit - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= limit) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return undefined;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(buffer);
}

function parseErrorXml(xml: string): {
  code?: string;
  message?: string;
  resource?: string;
  region?: string;
} {
  return {
    code: extractTag(xml, "Code"),
    message: extractTag(xml, "Message"),
    resource: extractTag(xml, "Resource"),
    region: extractTag(xml, "Region"),
  };
}

const XML_ROOT = /^\s*(?:<\?[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w.:-]*)/;

/** The name of a document's root element, without a namespace prefix. */
function xmlRoot(text: string): string | undefined {
  const name = XML_ROOT.exec(text)?.[1];
  return name?.slice(name.indexOf(":") + 1);
}

type CompletedPart = { partNumber: number; etag: string; checksum?: string };

const CHECKSUM_ELEMENTS: Record<ChecksumAlgorithm, string> = {
  sha256: "ChecksumSHA256",
  crc32c: "ChecksumCRC32C",
};

function buildCompleteMultipartXml(
  parts: CompletedPart[],
  algorithm: ChecksumConfig["algorithm"],
): string {
  const body = parts
    .map((part) => {
      const etag = ensureQuotedEtag(part.etag);
      const lines = [
        "  <Part>",
        `    <PartNumber>${part.partNumber}</PartNumber>`,
        `    <ETag>${escapeXml(etag)}</ETag>`,
      ];
      if (part.checksum) {
        if (algorithm === "none") {
          throw new Error("A part checksum needs a checksum algorithm configured on the client.");
        }
        const element = CHECKSUM_ELEMENTS[algorithm];
        lines.push(`    <${element}>${escapeXml(part.checksum)}</${element}>`);
      }
      lines.push("  </Part>");
      return lines.join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CompleteMultipartUpload>",
    body,
    "</CompleteMultipartUpload>",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeCompletedParts(parts: CompleteMultipartParams["parts"]): CompletedPart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("At least one part is required to complete a multipart upload.");
  }

  const normalized = parts.map((part) => ({
    partNumber: normalizePartNumber(part.partNumber),
    etag: part.etag,
    checksum: part.checksum,
  }));

  normalized.sort((a, b) => a.partNumber - b.partNumber);

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index]!.partNumber === normalized[index - 1]!.partNumber) {
      throw new Error("Duplicate part numbers are not allowed.");
    }
  }

  return normalized;
}

function normalizePartNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Part number must be a finite number.");
  }
  if (!Number.isInteger(value)) {
    throw new RangeError("Part number must be an integer.");
  }
  if (value < 1 || value > 10_000) {
    throw new RangeError("Part number must be between 1 and 10,000 inclusive.");
  }
  return value;
}

function validateUploadId(uploadId: string): string {
  if (typeof uploadId !== "string") {
    throw new TypeError("UploadId must be a string.");
  }
  const trimmed = uploadId.trim();
  if (!trimmed) {
    throw new Error("UploadId cannot be empty.");
  }
  return trimmed;
}

/** An entity tag as RFC 9110 spells it: quoted, and weak ones left whole. */
function ensureQuotedEtag(etag: string): string {
  const trimmed = etag.trim();
  if (!trimmed) {
    throw new Error("ETag cannot be empty.");
  }
  if (/^(?:W\/)?".*"$/.test(trimmed)) {
    return trimmed;
  }
  return `"${trimmed}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

/** A document that is the one asked for but lacks what it has to carry. */
class MalformedXml extends Error {}

/** The text of a `tag` that a document has to carry. */
function requiredTag(xml: string, tag: string): string {
  const value = extractTag(xml, tag);
  if (!value) {
    throw new MalformedXml(`has no <${tag}>`);
  }
  return value;
}

function parseListObjectsV2(xml: string): ListObjectsV2Response {
  const contents: ListObjectsV2Response["contents"] = [];
  const commonPrefixes: string[] = [];
  /*
   * A listing asked for with `encoding-type=url` url-encodes every name in
   * it, a space as `+`. Decoded here, so a key reads the same however it was
   * listed.
   */
  const urlEncoded = extractTag(xml, "EncodingType") === "url";
  const name = (value: string): string =>
    urlEncoded ? decodeURIComponent(value.replaceAll("+", " ")) : value;

  for (const match of xml.matchAll(elementPattern("Contents", "g"))) {
    const section = match[1] ?? "";
    const key = name(requiredTag(section, "Key"));
    const size = extractTag(section, "Size");
    if (!size || !/^\d+$/.test(size)) {
      throw new MalformedXml(`lists ${JSON.stringify(key)} without a valid <Size>`);
    }
    const lastModified = extractTag(section, "LastModified");
    if (!lastModified) {
      throw new MalformedXml(`lists ${JSON.stringify(key)} without a <LastModified>`);
    }
    const etag = extractTag(section, "ETag");
    contents.push({
      key,
      size: Number(size),
      etag: etag ? ensureQuotedEtag(etag) : undefined,
      lastModified,
      storageClass: extractTag(section, "StorageClass") || undefined,
    });
  }

  for (const match of xml.matchAll(elementPattern("CommonPrefixes", "g"))) {
    commonPrefixes.push(name(requiredTag(match[1] ?? "", "Prefix")));
  }

  const isTruncated = extractTag(xml, "IsTruncated") === "true";
  const nextContinuationToken = extractTag(xml, "NextContinuationToken") || undefined;
  /*
   * A store that answers V1 semantics — several S3-compatible ones do, ignoring
   * `list-type=2` outright — says "there is more" with `<NextMarker>` and never
   * sends a continuation token. Surfaced under its own name rather than folded
   * into `nextContinuationToken`, because the two are not interchangeable: a
   * marker has to go back as `marker`, and quietly sending it as
   * `continuation-token` would be ignored by the store that asked for it — the
   * same page forever, wearing the fix's clothes.
   */
  let nextMarker = extractTag(xml, "NextMarker");
  nextMarker = nextMarker ? name(nextMarker) : undefined;
  /*
   * A V1 listing sends `<NextMarker>` only with a delimiter. Without one, the
   * specification says to resume after the last name listed.
   */
  if (isTruncated && !nextContinuationToken && !nextMarker) {
    const key = contents.at(-1)?.key;
    const prefix = commonPrefixes.at(-1);
    const last = key && prefix ? (key > prefix ? key : prefix) : (key ?? prefix);
    if (!last) {
      throw new MalformedXml("is truncated but names nowhere to resume");
    }
    nextMarker = last;
  }

  return {
    contents,
    commonPrefixes,
    isTruncated,
    nextContinuationToken,
    nextMarker,
  };
}

/**
 * Reads one element's text out of an XML fragment.
 *
 * The open-tag pattern tolerates attributes: `<Key>` and `<Key xmlns:x="…">`
 * are the same element, and a namespace declaration on it is not a different
 * one. It still will not match a longer name — `<KeyCount>` is not a `<Key>` —
 * because an attribute has to be separated by whitespace.
 */
function extractTag(section: string, tag: string): string | undefined {
  const match = elementPattern(tag).exec(section);
  return match ? decodeXmlText(match[1] ?? "") : undefined;
}

/**
 * Matches one `tag` element, its content in group 1. A self-closing element
 * matches with no content rather than as an open tag. A CDATA section is
 * consumed whole, so a closing tag inside one is text.
 */
function elementPattern(tag: string, flags?: string): RegExp {
  return new RegExp(
    `<${tag}(?:\\s[^>]*?)?(?:\\/>|>((?:<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|[\\s\\S])*?)<\\/${tag}\\s*>)`,
    flags,
  );
}

const CDATA_SECTION = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/**
 * Turns an element's raw content into the text it stands for.
 *
 * CDATA is the other way XML carries text that would otherwise need escaping,
 * and its content is literal: `&amp;` inside one is five characters, not an
 * ampersand. Text around a section is decoded, the section itself is not.
 */
function decodeXmlText(raw: string): string {
  let text = "";
  let last = 0;
  for (const match of raw.matchAll(CDATA_SECTION)) {
    text += decodeXml(raw.slice(last, match.index)) + match[1]!;
    last = match.index + match[0].length;
  }
  return text + decodeXml(raw.slice(last));
}

const XML_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  amp: "&",
};

const XML_ENTITY = /&(#\d+|#[Xx][\dA-Fa-f]+|quot|apos|lt|gt|amp);/g;

const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Decodes the entities an S3 response can contain, in a single pass.
 *
 * Single-pass is the whole design. Sequential replaces cascade, and decoding
 * `&amp;` first — as this used to — feeds its own output to the passes after
 * it: the text `&amp;lt;`, which is how a key containing the four characters
 * `&lt;` is escaped, came back out as `<`. Here every reference is resolved
 * once and never re-read, so `&amp;` is no more special than `&gt;` is.
 *
 * Numeric character references are decoded too, decimal and hexadecimal alike.
 * They are not exotic: SeaweedFS escapes the quotes around an ETag as `&#34;`,
 * which the old decoder left in place, so a listed etag never matched the one
 * a HEAD reported. Anything unrecognised or outside Unicode is left exactly as
 * written — a malformed reference is not worth failing a listing over.
 */
function decodeXml(value: string): string {
  return value.replace(XML_ENTITY, (reference: string, body: string) => {
    if (!body.startsWith("#")) {
      return XML_ENTITIES[body] ?? reference;
    }
    const hex = body[1] === "x" || body[1] === "X";
    const codePoint = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) {
      return reference;
    }
    /*
     * Lone surrogates are deliberately allowed through: an encoder that writes
     * an astral character as the pair `&#55357;&#56832;` is writing two halves
     * of one UTF-16 character, and JavaScript strings put them back together.
     */
    return String.fromCodePoint(codePoint);
  });
}

function globalFetch(): typeof fetch | undefined {
  if (typeof fetch === "function") {
    return fetch.bind(globalThis);
  }
  return undefined;
}

function missingFetch(): never {
  throw new Error(
    "fetch is not available in this environment; provide a fetch implementation in S3ClientConfig.fetch",
  );
}
