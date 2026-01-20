import {
  buildRequestUrl,
  applyQuery,
  createHeaders,
  defaultContentTypeResolver,
  presignUrl,
  resolveContentType,
  send,
  signRequest,
  isPayloadStream,
} from "./core";
import type {
  Methods,
  ContentTypeResolver,
  Credentials,
  AbortMultipartParams,
  CompleteMultipartParams,
  DeleteObjectParams,
  GetObjectParams,
  HeadObjectParams,
  ListObjectsV2Params,
  ListObjectsV2Response,
  MultipartInitParams,
  MultipartInitResult,
  ObjectRequest,
  PresignParams,
  PutObjectParams,
  S3ClientConfig,
  RetryConfig,
  ChecksumConfig,
  UploadPartParams,
  UploadPartResult,
} from "./types";
import { S3Error } from "./error";
import { isPlainObject } from "./utils/is";

interface RequestOptions {
  body?: BodyInit | ReadableStream<Uint8Array> | null;
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
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  jitter: true,
};

const MAX_INLINE_CHECKSUM_BYTES = 16 * 1024 * 1024;

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
  private readonly retryConfig: RetryConfig;

  /**
   * Creates a new client instance.
   *
   * @param config - Connection, credential, and runtime overrides for S3.
   */
  constructor(config: S3ClientConfig) {
    this.region = config.region;
    this.endpoint = config.endpoint;
    this.bucketStyle = config.bucketStyle ?? "virtual";
    this.credentials = config.credentials;
    this.defaultBucket = config.defaultBucket;
    this.fetcher = config.fetch ?? globalFetch() ?? missingFetch();
    this.contentTypeResolver =
      config.contentTypeResolver ?? defaultContentTypeResolver;
    this.checksumConfig = config.checksum
      ? { ...config.checksum }
      : { algorithm: "none" };
    const retry = config.retry
      ? { ...DEFAULT_RETRY_CONFIG, ...config.retry }
      : { ...DEFAULT_RETRY_CONFIG };
    this.retryConfig = {
      ...retry,
      maxAttempts: Math.max(1, retry.maxAttempts),
      baseDelayMs: Math.max(0, retry.baseDelayMs),
    };
    this.clockSkewMs = normalizeClockSkew(config.clockSkewMs ?? 0);
  }

  /**
   * Executes a GET Object request and returns the raw {@link Response}. For
   * streamed consumption prefer {@link Response.body} or {@link streamGet}.
   *
   * Supports conditional requests via `ifMatch`, `ifNoneMatch`, `ifModifiedSince`,
   * and `ifUnmodifiedSince`. When the object hasn't changed, S3 may return a
   * `304 Not Modified` response with no body, which is treated as success.
   *
   * @param params - Request configuration including bucket and key.
   */
  async get(params: GetObjectParams): Promise<Response> {
    return await this.execute("GET", params, { expectedStatus: [200, 304] });
  }

  /**
   * Issues a HEAD Object call returning metadata-only responses.
   *
   * Supports conditional requests via `ifMatch`, `ifNoneMatch`, `ifModifiedSince`,
   * and `ifUnmodifiedSince`. When the object hasn't changed, S3 may return a
   * `304 Not Modified` response, which is treated as success.
   *
   * @param params - Request configuration including bucket and key.
   */
  async head(params: HeadObjectParams): Promise<Response> {
    return await this.execute("HEAD", params, { expectedStatus: [200, 304] });
  }

  /**
   * Uploads an object using PUT semantics. Content-Type is resolved via the
   * configured resolver when not explicitly supplied.
   *
   * Supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for conditional
   * overwrites. Note that not all S3-compatible providers support these headers.
   * When conditions fail, S3 returns `412 Precondition Failed`.
   *
   * @param params - Upload configuration including payload and metadata.
   */
  async put(params: PutObjectParams): Promise<Response> {
    const { body: rawBody, contentType: rawContentType } = params;
    let body: BodyInit | ReadableStream<Uint8Array> | null;
    let contentType: string | false | undefined;

    if (isPlainObject(rawBody)) {
      body = JSON.stringify(rawBody);
      contentType =
        rawContentType === undefined ? "application/json" : rawContentType;
    } else {
      body = rawBody as BodyInit | ReadableStream<Uint8Array> | null;
      contentType = rawContentType;
    }

    const resolvedContentType = resolveContentType(
      params.key,
      contentType,
      this.contentTypeResolver,
    );
    return await this.execute("PUT", params, {
      body,
      contentType: resolvedContentType,
      cacheControl: params.cacheControl,
      contentDisposition: params.contentDisposition,
      contentEncoding: params.contentEncoding,
      expectedStatus: [200, 412],
    });
  }

  /**
   * Deletes an object. Treats both 200 and 204 responses as success.
   *
   * @param params - Request configuration including bucket and key.
   */
  async del(params: DeleteObjectParams): Promise<Response> {
    return await this.execute("DELETE", params, { expectedStatus: [200, 204] });
  }

  /**
   * Lists objects using the ListObjectsV2 API and parses a convenient result
   * structure for contents and common prefixes.
   *
   * @param params - Listing options such as prefix, delimiter, and pagination.
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

    const baseQuery: Record<string, string> = { "list-type": "2" };
    if (params.prefix) baseQuery.prefix = params.prefix;
    if (params.delimiter) baseQuery.delimiter = params.delimiter;
    if (params.continuationToken)
      baseQuery["continuation-token"] = params.continuationToken;
    if (typeof params.maxKeys === "number")
      baseQuery["max-keys"] = String(params.maxKeys);

    applyQuery(url, baseQuery);
    if (params.query) {
      applyQuery(url, params.query);
    }

    const response = await this.perform({
      method: "GET",
      url,
      headers,
      bucket,
      key: undefined,
      expectedStatus: 200,
      signal: params.signal,
    });

    const text = await response.text();
    return parseListObjectsV2(text);
  }

  /**
   * Generates a SigV4 presigned URL for the provided method and object key.
   *
   * @param params - Method, bucket/key, expiry, and optional overrides.
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
      expiresInSeconds: params.expiresInSeconds,
      unsignedPayload: true,
    });

    return result.url.toString();
  }

  async initiateMultipart(
    params: MultipartInitParams,
  ): Promise<MultipartInitResult> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const contentType = resolveContentType(
      key,
      params.contentType,
      this.contentTypeResolver,
    );
    const url = buildRequestUrl({
      endpoint: this.endpoint,
      bucketStyle: this.bucketStyle,
      bucket,
      key,
    });

    url.searchParams.set("uploads", "");
    applyQuery(url, params.query);

    const headers = createHeaders({
      headers: params.headers,
      contentType,
      cacheControl: params.cacheControl,
      contentDisposition: params.contentDisposition,
      contentEncoding: params.contentEncoding,
    });

    const response = await this.perform({
      method: "POST",
      url,
      headers,
      bucket,
      key,
      expectedStatus: 200,
      signal: params.signal,
    });

    const text = await response.text();
    const uploadId = parseInitiateMultipartUpload(text);
    if (!uploadId) {
      throw new Error(
        "UploadId not present in InitiateMultipartUpload response.",
      );
    }

    return { uploadId };
  }

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

    const response = await this.perform({
      method: "PUT",
      url,
      headers,
      body: params.body,
      bucket,
      key,
      expectedStatus: 200,
      signal: params.signal,
    });

    const etagHeader = response.headers.get("etag");
    response.body?.cancel?.();

    if (!etagHeader) {
      throw new Error("ETag header missing from UploadPart response.");
    }

    const etag = stripQuotes(etagHeader);
    if (!etag) {
      throw new Error("ETag header was empty in UploadPart response.");
    }

    return { etag };
  }

  /**
   * Completes a multipart upload by assembling previously uploaded parts.
   *
   * Supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for conditional
   * overwrites. Note that not all S3-compatible providers support these headers.
   * When conditions fail, S3 returns `412 Precondition Failed`.
   *
   * @param params - Configuration for completing the multipart upload.
   */
  async completeMultipart(params: CompleteMultipartParams): Promise<Response> {
    const bucket = this.resolveBucket(params.bucket);
    const key = this.resolveKey(params);
    const uploadId = validateUploadId(params.uploadId);
    const parts = normalizeCompletedParts(params.parts);
    const payload = buildCompleteMultipartXml(parts);

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

    return await this.perform({
      method: "POST",
      url,
      headers,
      body: payload,
      bucket,
      key,
      expectedStatus: [200, 412],
      signal: params.signal,
    });
  }

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
      expectedStatus: [200, 202, 204], // TODO: study if this should also support 412
      signal: params.signal,
    });

    response.body?.cancel?.();
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

    if (params.query) {
      applyQuery(url, params.query);
    }

    await this.applyChecksum(method, options.body, headers);

    const response = await this.perform({
      method,
      url,
      headers,
      body: options.body,
      bucket,
      key,
      expectedStatus: options.expectedStatus,
      signal: params.signal,
    });

    return response;
  }

  private async perform(context: PerformContext): Promise<Response> {
    const credentials = await this.resolveCredentials();
    const unsignedPayload = shouldUseUnsignedPayload(
      context.method,
      context.body,
    );
    const maxAttempts = Math.max(1, this.retryConfig.maxAttempts);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;

      let headers = context.headers;

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
      }

      const request = new Request(context.url.toString(), {
        method: context.method,
        headers,
        body: hasBody(context.method) ? (context.body ?? null) : undefined,
        signal: context.signal,
      });

      try {
        const { response } = await send(
          { request, signal: context.signal },
          this.fetcher,
        );

        this.updateClockSkew(response);

        if (matchesExpected(response.status, context.expectedStatus)) {
          return response;
        }

        const error = await createError(response);
        if (!response.bodyUsed) {
          response.body?.cancel?.();
        }

        if (
          !this.shouldRetry(
            context.method,
            response,
            error,
            attempt,
            maxAttempts,
          )
        ) {
          throw error;
        }

        lastError = error;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        if (
          !this.shouldRetry(
            context.method,
            undefined,
            error,
            attempt,
            maxAttempts,
          )
        ) {
          throw ensureError(error);
        }

        lastError = error;
      }

      let delayMs = this.computeBackoffDelay(attempt);
      if (
        lastError instanceof S3Error &&
        typeof lastError.retryAfter === "number"
      ) {
        const retryDelay = Math.ceil(lastError.retryAfter * 1000);
        if (retryDelay > delayMs) {
          delayMs = retryDelay;
        }
      }
      if (delayMs > 0) {
        await this.delay(delayMs, context.signal);
      }
    }

    throw ensureError(
      lastError ?? new Error("Request failed after exhausting retry attempts."),
    );
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
    if (
      !credentials ||
      !credentials.accessKeyId ||
      !credentials.secretAccessKey
    ) {
      throw new Error("Invalid credentials resolved for S3Client.");
    }
    return credentials;
  }

  private async applyChecksum(
    method: Methods,
    body: BodyInit | ReadableStream<Uint8Array> | null | undefined,
    headers: Headers,
  ): Promise<void> {
    if (method.toUpperCase() !== "PUT") {
      return;
    }

    const algorithm = this.checksumConfig.algorithm;
    if (algorithm === "none") {
      return;
    }

    const normalized = await normalizeBodyForChecksum(
      body,
      MAX_INLINE_CHECKSUM_BYTES,
    );

    if (!("bytes" in normalized)) {
      if (this.checksumConfig.requireOnPut) {
        const reason = formatChecksumFailureReason(normalized.reason);
        throw new Error(
          `Unable to compute ${algorithm} checksum for PUT payload: ${reason}.`,
        );
      }
      return;
    }

    const value = await computeChecksumValue(normalized.bytes, algorithm);
    headers.set(resolveChecksumHeaderName(algorithm), value);
  }

  private createSigningDate(): Date {
    return new Date(Date.now() + this.clockSkewMs);
  }

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
    this.clockSkewMs = normalizeClockSkew(skew);
  }

  private shouldRetry(
    method: Methods,
    response: Response | undefined,
    error: unknown,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    if (attempt >= maxAttempts) {
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

    if (!isRetryEligibleMethod(method)) {
      return false;
    }

    if (response) {
      if (error instanceof S3Error && error.retriable) {
        return true;
      }
      return isRetriableStatus(response.status);
    }

    if (error instanceof S3Error) {
      return error.retriable ?? false;
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
        reject(ensureError(abortSignal.reason ?? new Error("Aborted")));
        return;
      }

      function cleanup(): void {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
      }

      function onAbort(): void {
        cleanup();
        reject(ensureError(abortSignal.reason ?? new Error("Aborted")));
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
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBytes) {
      return { reason: "too-large" };
    }
    const buffer = await body.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maxBytes) {
      return { reason: "too-large" };
    }
    return { bytes, size: bytes.byteLength };
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

async function computeChecksumValue(
  bytes: Uint8Array,
  algorithm: ChecksumAlgorithm,
): Promise<string> {
  if (algorithm === "sha256") {
    return await computeSha256Base64(bytes);
  }
  if (algorithm === "crc32c") {
    return computeCrc32cBase64(bytes);
  }
  throw new Error(`Unsupported checksum algorithm: ${algorithm}`);
}

function resolveChecksumHeaderName(algorithm: ChecksumAlgorithm): string {
  return algorithm === "sha256"
    ? "x-amz-checksum-sha256"
    : "x-amz-checksum-crc32c";
}

async function computeSha256Base64(data: Uint8Array): Promise<string> {
  const view =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data
      : new Uint8Array(data);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    view as unknown as BufferSource,
  );
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
  for (const byte of data) {
    const tableIndex = (crc ^ byte) & 0xff;
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

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric >= 0 ? numeric : undefined;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    return undefined;
  }
  const deltaSeconds = Math.ceil((parsedDate - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : undefined;
}

function normalizeClockSkew(skew: number): number {
  if (!Number.isFinite(skew)) {
    return 0;
  }
  return skew;
}

function isRetryEligibleMethod(method: Methods): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

function isRetriableStatus(status: number): boolean {
  if (status === 429) {
    return true;
  }
  return status >= 500 && status !== 501 && status !== 505;
}

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return new Error(String((error as { message?: unknown }).message));
  }
  return new Error(String(error ?? "Unknown error"));
}

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError";
  }
  return false;
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
  if (typeof body === "string") return false;
  if (typeof Blob !== "undefined" && body instanceof Blob) return false;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer)
    return false;
  if (ArrayBuffer.isView(body)) return false;
  return isPayloadStream(body as ReadableStream<Uint8Array>);
}

async function createError(response: Response): Promise<S3Error> {
  const requestId = response.headers.get("x-amz-request-id") ?? undefined;
  const extendedRequestId = response.headers.get("x-amz-id-2") ?? undefined;
  let message = response.statusText || `HTTP ${response.status}`;
  let code: string | undefined;
  let resource: string | undefined;
  let region: string | undefined;
  let bodyText: string | undefined;

  try {
    const text = await readErrorBody(response);
    if (text) {
      bodyText = text;
      const parsed = parseErrorXml(text);
      if (parsed.message) message = parsed.message;
      if (parsed.code) code = parsed.code;
      resource = parsed.resource ?? resource;
      region = parsed.region ?? region;
    }
  } catch {
    // ignore parsing errors for now
  }

  const bucketRegion = response.headers.get("x-amz-bucket-region") ?? undefined;
  const retryAfter = parseRetryAfterHeader(response.headers.get("retry-after"));
  const retriable = determineErrorRetriable(response.status, code);

  // Capture headers for debugging
  const headersRecord: Record<string, string> = {};
  // eslint-disable-next-line unicorn/no-array-for-each
  response.headers.forEach((value, key) => {
    headersRecord[key] = value;
  });

  return new S3Error({
    message,
    status: response.status,
    code,
    requestId,
    extendedRequestId,
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
      body: bodyText,
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
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
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

function parseInitiateMultipartUpload(xml: string): string | undefined {
  return extractTag(xml, "UploadId") ?? undefined;
}

type CompletedPart = { partNumber: number; etag: string };

function buildCompleteMultipartXml(parts: CompletedPart[]): string {
  const body = parts
    .map((part) => {
      const etag = ensureQuotedEtag(part.etag);
      return [
        "  <Part>",
        `    <PartNumber>${part.partNumber}</PartNumber>`,
        `    <ETag>${escapeXml(etag)}</ETag>`,
        "  </Part>",
      ].join("\n");
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

function normalizeCompletedParts(
  parts: CompleteMultipartParams["parts"],
): CompletedPart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(
      "At least one part is required to complete a multipart upload.",
    );
  }

  const normalized = parts.map((part) => ({
    partNumber: normalizePartNumber(part.partNumber),
    etag: part.etag,
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

function ensureQuotedEtag(etag: string): string {
  const trimmed = etag.trim();
  if (!trimmed) {
    throw new Error("ETag cannot be empty.");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
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

function parseListObjectsV2(xml: string): ListObjectsV2Response {
  const contents: ListObjectsV2Response["contents"] = [];
  const commonPrefixes: string[] = [];

  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const section = match[1] ?? "";
    const key = extractTag(section, "Key");
    const size = extractTag(section, "Size");
    const etag = extractTag(section, "ETag");
    const lastModified = extractTag(section, "LastModified");
    const storageClass = extractTag(section, "StorageClass") ?? undefined;
    if (!key || !size || !etag || !lastModified) {
      continue;
    }
    contents.push({
      key,
      size: Number.parseInt(size, 10),
      etag: stripQuotes(etag),
      lastModified,
      storageClass,
    });
  }

  for (const match of xml.matchAll(
    /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g,
  )) {
    const prefix = extractTag(match[1] ?? "", "Prefix");
    if (prefix) {
      commonPrefixes.push(prefix);
    }
  }

  const isTruncated = extractTag(xml, "IsTruncated") === "true";
  const nextContinuationToken =
    extractTag(xml, "NextContinuationToken") ?? undefined;

  return {
    contents,
    commonPrefixes,
    isTruncated,
    nextContinuationToken,
  };
}

function extractTag(section: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = section.match(regex);
  const value = match?.[1];
  return typeof value === "string" ? decodeXml(value) : undefined;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
