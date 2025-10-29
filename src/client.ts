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
  DeleteObjectParams,
  GetObjectParams,
  HeadObjectParams,
  ListObjectsV2Params,
  ListObjectsV2Response,
  ObjectRequest,
  PresignParams,
  PutObjectParams,
  S3ClientConfig,
} from "./types";
import { S3Error } from "./error";

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
  }

  /**
   * Executes a GET Object request and returns the raw {@link Response}. For
   * streamed consumption prefer {@link Response.body} or {@link streamGet}.
   *
   * @param params - Request configuration including bucket and key.
   */
  async get(params: GetObjectParams): Promise<Response> {
    return await this.execute("GET", params, { expectedStatus: 200 });
  }

  /**
   * Performs a GET Object request but leaves response streaming decisions to
   * the caller. This mirrors {@link get} yet clearly signals streaming usage.
   *
   * @param params - Request configuration including bucket and key.
   */
  async streamGet(params: GetObjectParams): Promise<Response> {
    return await this.execute("GET", params, { expectedStatus: 200 });
  }

  /**
   * Issues a HEAD Object call returning metadata-only responses.
   *
   * @param params - Request configuration including bucket and key.
   */
  async head(params: HeadObjectParams): Promise<Response> {
    return await this.execute("HEAD", params, { expectedStatus: 200 });
  }

  /**
   * Uploads an object using PUT semantics. Content-Type is resolved via the
   * configured resolver when not explicitly supplied.
   *
   * @param params - Upload configuration including payload and metadata.
   */
  async put(params: PutObjectParams): Promise<Response> {
    const contentType = resolveContentType(
      params.key,
      params.contentType,
      this.contentTypeResolver,
    );
    return await this.execute("PUT", params, {
      body: params.body,
      contentType: contentType,
      cacheControl: params.cacheControl,
      contentDisposition: params.contentDisposition,
      contentEncoding: params.contentEncoding,
      expectedStatus: 200,
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
  async list(params: ListObjectsV2Params): Promise<ListObjectsV2Response> {
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
    });

    if (params.query) {
      applyQuery(url, params.query);
    }

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
    const headers = context.headers;
    const unsignedPayload = shouldUseUnsignedPayload(
      context.method,
      context.body,
    );
    const result = await signRequest({
      method: context.method,
      url: context.url,
      headers,
      body: context.body,
      credentials,
      region: this.region,
      unsignedPayload,
    });

    const request = new Request(context.url.toString(), {
      method: context.method,
      headers: result.headers,
      body: hasBody(context.method) ? (context.body ?? null) : undefined,
      signal: context.signal,
    });

    const { response } = await send(
      { request, signal: context.signal },
      this.fetcher,
    );

    if (!matchesExpected(response.status, context.expectedStatus)) {
      throw await createError(response);
    }

    return response;
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

  private async resolveCredentials(): Promise<Credentials> {
    const value = this.credentials;
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
}

// #region Internal

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

  try {
    const text = await readErrorBody(response);
    if (text) {
      const parsed = parseErrorXml(text);
      if (parsed.message) message = parsed.message;
      if (parsed.code) code = parsed.code;
    }
  } catch {
    // ignore parsing errors for now
  }

  return new S3Error({
    message,
    status: response.status,
    code,
    requestId,
    extendedRequestId,
  });
}

const textDecoder = new TextDecoder();
async function readErrorBody(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return undefined;
  }
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const limit = 64 * 1024;
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

function parseErrorXml(xml: string): { code?: string; message?: string } {
  return {
    code: extractTag(xml, "Code"),
    message: extractTag(xml, "Message"),
  };
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
