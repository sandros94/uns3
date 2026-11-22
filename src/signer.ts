import { uriEncode } from "./internal/encode.ts";
import { isArrayBuffer, isArrayBufferView, isBlob, isReadableStream } from "./internal/is.ts";
import { finalizeQuery } from "./internal/serializer.ts";
import type { Credentials, Methods } from "./types.ts";

const encoder = new TextEncoder();
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Options of {@link signRequest}. */
export interface SignRequestInput {
  /** The request's method. */
  method: Methods;
  /** The request's URL, bucket and key included. It is not changed. */
  url: URL;
  /** Region to sign for. */
  region: string;
  /** Credentials to sign with. */
  credentials: Credentials;
  /** Headers to sign and send. `host` is added when missing. */
  headers?: Headers;
  /** The body, hashed into the signature unless it is a stream or `unsignedPayload` is set. */
  body?: BodyInit | ReadableStream<Uint8Array> | null;
  /**
   * Time of the signature. The store refuses one more than 15 minutes away
   * from its own clock.
   *
   * @default new Date()
   */
  datetime?: Date;
  /**
   * Sign the payload as `UNSIGNED-PAYLOAD` instead of hashing the body.
   *
   * @default false
   */
  unsignedPayload?: boolean;
  /**
   * Where the derived signing key is kept. `false` derives one for this call.
   *
   * @default sharedSigningKeyCache
   */
  signingKeyCache?: SigningKeyCache | false;
}

/** What {@link signRequest} resolves with. Send `url` with `headers`. */
export interface SignRequestResult {
  /**
   * The URL to send, its query encoded the way it was signed. Send this one
   * rather than your own: `URLSearchParams` writes a space as `+`, which the
   * store would not match against the signature.
   */
  url: URL;
  /** The headers to send: yours, plus `authorization`, `x-amz-date` and `x-amz-content-sha256`. */
  headers: Headers;
  /** SHA-256 of the body in hex, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  /** Time of the signature, as `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
  /** Names of the signed headers, separated by `;`. */
  signedHeaders: string;
}

/** Options of {@link presignUrl}. */
export interface PresignInput {
  /** The method the URL authorizes. */
  method: Methods;
  /** The URL to presign, bucket and key included. It is not changed. */
  url: URL;
  /** Region to sign for. */
  region: string;
  /** Credentials to sign with. A session token goes in the URL's query. */
  credentials: Credentials;
  /** Headers to sign. Whoever uses the URL must send them with the same values. */
  headers?: Headers;
  /**
   * When the URL starts being valid.
   *
   * @default new Date()
   */
  datetime?: Date;
  /**
   * How long the URL stays valid, in seconds: an integer from 1 to 604800
   * (seven days).
   *
   * @default 900
   */
  expiresInSeconds?: number;
  /**
   * Where the derived signing key is kept. `false` derives one for this call.
   *
   * @default sharedSigningKeyCache
   */
  signingKeyCache?: SigningKeyCache | false;
}

/** What {@link presignUrl} resolves with. */
export interface PresignResult {
  /** The presigned URL. */
  url: URL;
  /** Always `UNSIGNED-PAYLOAD`: whoever uses the URL chooses the body. */
  payloadHash: string;
  /** Time of the signature, as `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
  /** Names of the signed headers, separated by `;`. */
  signedHeaders: string;
}

/**
 * Signs a request with AWS Signature Version 4 (SigV4), for sending it with
 * your own `fetch`. Send the returned `url` with the returned `headers`.
 *
 * @param input - The request to sign and the credentials to sign it with.
 * @returns The URL and headers to send, and what the signature covers.
 * @throws {TypeError} When the credentials have no secret, or `signingKeyCache` is not a cache.
 * @example
 * ```ts
 * import { signRequest } from "uns3/signer";
 *
 * const { url, headers } = await signRequest({
 *   method: "GET",
 *   url: new URL("https://my-bucket.s3.us-east-1.amazonaws.com/hello.txt"),
 *   region: "us-east-1",
 *   credentials,
 *   unsignedPayload: true,
 * });
 * const response = await fetch(url, { headers });
 * ```
 */
export async function signRequest(input: SignRequestInput): Promise<SignRequestResult> {
  const { credentials, region } = input;
  const date = input.datetime ?? new Date();
  const { amzDate, shortDate } = formatAmzDate(date);
  const headers = cloneHeaders(input.headers);
  const url = finalizeQuery(new URL(input.url));

  ensureHost(headers, url);
  headers.set("x-amz-date", amzDate);

  if (credentials.sessionToken) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }

  const payloadHash = await resolvePayloadHash(input, headers);
  headers.set("x-amz-content-sha256", payloadHash);

  const { canonical, signedHeaders } = canonicalizeHeaders(headers);
  const canonicalRequest = buildCanonicalRequest(
    input.method,
    url,
    canonical,
    signedHeaders,
    payloadHash,
  );

  const canonicalRequestHash = await sha256Hex(encoder.encode(canonicalRequest));
  const credentialScope = `${shortDate}/${region}/${SERVICE}/aws4_request`;

  const stringToSign = buildStringToSign(amzDate, credentialScope, canonicalRequestHash);
  const signature = await calculateSignature(
    credentials,
    shortDate,
    region,
    stringToSign,
    input.signingKeyCache,
  );
  const authorization = buildAuthorizationHeader(
    credentials.accessKeyId,
    credentialScope,
    signedHeaders,
    signature,
  );
  headers.set("authorization", authorization);

  return {
    url,
    headers,
    payloadHash,
    amzDate,
    signedHeaders,
  };
}

/**
 * Presigns a URL: the result authorizes `method` on that URL until it
 * expires, with no other credentials. Anyone who has it can use it.
 *
 * @param input - The URL to presign, its method, expiry and credentials.
 * @returns The presigned URL, and what the signature covers.
 * @throws {RangeError} When `expiresInSeconds` is not an integer from 1 to 604800.
 * @throws {TypeError} When the credentials have no secret, or `signingKeyCache` is not a cache.
 * @example
 * ```ts
 * import { presignUrl } from "uns3/signer";
 *
 * const { url } = await presignUrl({
 *   method: "GET",
 *   url: new URL("https://my-bucket.s3.us-east-1.amazonaws.com/report.pdf"),
 *   region: "us-east-1",
 *   credentials,
 *   expiresInSeconds: 3600,
 * });
 * ```
 */
export async function presignUrl(input: PresignInput): Promise<PresignResult> {
  const expires = resolveExpiry(input.expiresInSeconds);
  const { credentials, region } = input;
  const date = input.datetime ?? new Date();
  const { amzDate, shortDate } = formatAmzDate(date);
  const headers = cloneHeaders(input.headers);
  ensureHost(headers, input.url);

  const payloadHash = UNSIGNED_PAYLOAD;

  const { canonical, signedHeaders } = canonicalizeHeaders(headers);
  const credentialScope = `${shortDate}/${region}/${SERVICE}/aws4_request`;
  const credential = `${credentials.accessKeyId}/${credentialScope}`;

  const presignedUrl = new URL(input.url);
  const search = presignedUrl.searchParams;
  search.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  search.set("X-Amz-Credential", credential);
  search.set("X-Amz-Date", amzDate);
  search.set("X-Amz-Expires", String(expires));
  search.set("X-Amz-SignedHeaders", signedHeaders);

  /*
   * The token travels in the query, where the signature covers it, and never as
   * a signed header: whoever uses a presigned URL sends the URL and nothing else.
   */
  if (credentials.sessionToken) {
    search.set("X-Amz-Security-Token", credentials.sessionToken);
  }

  const canonicalRequest = buildCanonicalRequest(
    input.method,
    presignedUrl,
    canonical,
    signedHeaders,
    payloadHash,
  );

  const canonicalRequestHash = await sha256Hex(encoder.encode(canonicalRequest));
  const stringToSign = buildStringToSign(amzDate, credentialScope, canonicalRequestHash);
  const signature = await calculateSignature(
    credentials,
    shortDate,
    region,
    stringToSign,
    input.signingKeyCache,
  );
  presignedUrl.searchParams.set("X-Amz-Signature", signature);
  /*
   * The signature covers the canonical (RFC 3986) query, so the returned URL
   * uses that encoding, not the form encoding of `URLSearchParams`. Otherwise
   * a URL with a space in it would not match its own signature.
   */
  finalizeQuery(presignedUrl);

  return {
    url: presignedUrl,
    payloadHash,
    amzDate,
    signedHeaders,
  };
}

// #region Internal

async function resolvePayloadHash(input: SignRequestInput, headers: Headers): Promise<string> {
  if (input.unsignedPayload) return UNSIGNED_PAYLOAD;

  const existing = headers.get("x-amz-content-sha256");
  if (existing) return existing;

  if (!input.body) {
    return EMPTY_PAYLOAD_SHA256;
  }

  if (typeof input.body === "string") {
    return await sha256Hex(encoder.encode(input.body));
  }

  if (isArrayBuffer(input.body)) {
    return await sha256Hex(new Uint8Array(input.body));
  }

  if (isArrayBufferView(input.body)) {
    return await sha256Hex(
      new Uint8Array(input.body.buffer, input.body.byteOffset, input.body.byteLength),
    );
  }

  if (isBlob(input.body)) {
    const buffer = await input.body.arrayBuffer();
    return await sha256Hex(new Uint8Array(buffer));
  }

  if (isReadableStream(input.body)) {
    return UNSIGNED_PAYLOAD;
  }

  return UNSIGNED_PAYLOAD;
}

function ensureHost(headers: Headers, url: URL) {
  if (!headers.has("host")) {
    headers.set("host", url.host);
  }
}

function cloneHeaders(headers?: Headers): Headers {
  const next = new Headers();

  // eslint-disable-next-line unicorn/no-array-for-each
  headers?.forEach((value, key) => {
    next.append(key, value);
  });

  return next;
}

/**
 * Headers that are sent but never signed: hop-by-hop headers and others a
 * proxy or runtime may add, drop or rewrite in transit. Signing one ties the
 * signature to a hop the client does not control. This is the set
 * `@smithy/signature-v4` leaves unsigned.
 */
const UNSIGNABLE_HEADERS = new Set([
  "authorization",
  "cache-control",
  "connection",
  "expect",
  "from",
  "keep-alive",
  "max-forwards",
  "pragma",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "x-amzn-trace-id",
]);
const UNSIGNABLE_HEADER_PREFIX = /^(?:proxy-|sec-)/;

function isUnsignableHeader(name: string): boolean {
  return UNSIGNABLE_HEADERS.has(name) || UNSIGNABLE_HEADER_PREFIX.test(name);
}

function canonicalizeHeaders(headers: Headers): {
  canonical: string;
  signedHeaders: string;
} {
  const headerMap = new Map<string, string[]>();

  // eslint-disable-next-line unicorn/no-array-for-each
  headers.forEach((value, key) => {
    const lower = key.trim().toLowerCase();
    if (!lower || isUnsignableHeader(lower)) {
      return;
    }
    const normalized = value.trim().replace(/\s+/g, " ");
    const existing = headerMap.get(lower);
    if (existing) {
      existing.push(normalized);
    } else {
      headerMap.set(lower, [normalized]);
    }
  });

  const sortedKeys = [...headerMap.keys()].sort();
  const canonical = sortedKeys.map((key) => `${key}:${headerMap.get(key)!.join(",")}`).join("\n");
  const signedHeaders = sortedKeys.join(";");
  return {
    canonical: canonical + "\n",
    signedHeaders,
  };
}

function buildCanonicalRequest(
  method: string,
  url: URL,
  canonicalHeaders: string,
  signedHeaders: string,
  payloadHash: string,
): string {
  const canonicalUri = getCanonicalUri(url.pathname);
  const canonicalQuery = getCanonicalQuery(url.searchParams);
  return [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
}

/**
 * Builds the canonical URI for SigV4 signing.
 *
 * Segments are decoded then re-encoded to prevent double-encoding:
 * `URL.pathname` may already contain percent-encoded characters (e.g. `%20`),
 * so a naive `uriEncode(part)` would produce `%2520`. By decoding first we
 * normalise to raw characters, then apply a single RFC 3986 encoding pass.
 */
function getCanonicalUri(pathname: string): string {
  if (!pathname) return "/";
  const encodedPath = pathname
    .split("/")
    .map((part) => {
      if (!part) return part;
      try {
        const decoded = decodeURIComponent(part);
        return uriEncode(decoded);
      } catch {
        // If decoding fails, encode as-is (shouldn't happen with valid URLs)
        return uriEncode(part);
      }
    })
    .join("/");
  return encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;
}

/**
 * Builds the canonical query for signing: the same RFC 3986 encoding the wire
 * gets from {@link finalizeQuery}, then sorted by encoded name and encoded
 * value. The specification sorts after encoding, and the order differs from
 * that of the raw strings: `|` sorts after `B`, its encoding `%7C` before it.
 */
function getCanonicalQuery(params: URLSearchParams): string {
  const entries = [...params].map(([key, value]): [string, string] => [
    uriEncode(key, true),
    uriEncode(value, true),
  ]);
  entries.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? compareStrings(aValue, bValue) : compareStrings(aKey, bKey),
  );
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of an empty payload, a constant there is no point computing. */
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function calculateSignature(
  credentials: Credentials,
  shortDate: string,
  region: string,
  stringToSign: string,
  cache: SigningKeyCache | false = sharedSigningKeyCache,
): Promise<string> {
  if (typeof credentials.secretAccessKey !== "string" || !credentials.secretAccessKey) {
    throw new TypeError("Signing needs credentials with a secretAccessKey.");
  }
  if (cache !== false && typeof cache?.signingKey !== "function") {
    throw new TypeError("signingKeyCache must be a SigningKeyCache, or false.");
  }
  const signingKey =
    cache === false
      ? await deriveSigningKey(credentials.secretAccessKey, shortDate, region)
      : await cache.signingKey(credentials, shortDate, region);
  return toHex(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(stringToSign)));
}

/**
 * Keeps derived signing keys, so signing a request costs one HMAC instead of
 * five. A key is reused until its credentials, its day or its region change.
 *
 * Every client and signing call uses {@link sharedSigningKeyCache} unless you
 * pass a cache of its own: one per tenant, per department or per request.
 * Keys never cross between caches. A full cache drops the key used least
 * recently.
 *
 * Each key is a non-extractable `CryptoKey`, but its entry also holds the
 * secret it came from while the entry lives. `delete`, `clear`, or dropping
 * the cache releases both.
 *
 * @example
 * ```ts
 * const tenantKeys = new SigningKeyCache({ size: 4 });
 * const client = new S3Client({ endpoint, credentials, signingKeyCache: tenantKeys });
 * tenantKeys.delete(credentials.accessKeyId); // after revoking that key
 * ```
 */
export class SigningKeyCache {
  readonly #size: number;
  readonly #entries = new Map<string, { accessKeyId: string; key: Promise<CryptoKey> }>();

  /**
   * @param options - `size`: how many keys the cache holds, 16 by default.
   * @throws {TypeError} When `options` is not an object.
   * @throws {RangeError} When `size` is not a positive integer.
   */
  constructor(options: { size?: number } = {}) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("SigningKeyCache takes an options object, such as { size: 8 }.");
    }
    const { size = 16 } = options;
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new RangeError(`SigningKeyCache size must be a positive integer, got ${String(size)}.`);
    }
    this.#size = size;
  }

  /**
   * The signing key for `credentials` on `shortDate` (`YYYYMMDD`) in
   * `region`, from the cache or derived into it. The signer calls this, so
   * you only need it to sign by hand. Concurrent calls share one derivation,
   * and a failed one is not kept.
   *
   * @param credentials - Credentials the key is derived from.
   * @param shortDate - Day of the signature, as `YYYYMMDD`.
   * @param region - Region to sign for.
   * @returns A non-extractable HMAC key for signing.
   */
  signingKey(credentials: Credentials, shortDate: string, region: string): Promise<CryptoKey> {
    const { accessKeyId, secretAccessKey } = credentials;
    const entries = this.#entries;
    const id = JSON.stringify([accessKeyId, secretAccessKey, shortDate, region]);
    const cached = entries.get(id);
    if (cached) {
      entries.delete(id);
      entries.set(id, cached);
      return cached.key;
    }

    if (entries.size >= this.#size) {
      entries.delete(entries.keys().next().value!);
    }
    const key = deriveSigningKey(secretAccessKey, shortDate, region);
    entries.set(id, { accessKeyId, key });
    key.catch(() => {
      if (entries.get(id)?.key === key) entries.delete(id);
    });
    return key;
  }

  /**
   * Drops every key derived for `accessKeyId`, whatever its secret, day or
   * region. Use it once you revoke that access key.
   *
   * @param accessKeyId - The access key whose keys to drop.
   */
  delete(accessKeyId: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.accessKeyId === accessKeyId) this.#entries.delete(id);
    }
  }

  /** Drops every key. */
  clear(): void {
    this.#entries.clear();
  }
}

/**
 * The cache every client and signing call uses unless you pass one of its
 * own. Call `sharedSigningKeyCache.delete(accessKeyId)` once you revoke an
 * access key, or `clear()` it.
 */
export const sharedSigningKeyCache: SigningKeyCache = /* @__PURE__ */ new SigningKeyCache();

async function deriveSigningKey(
  secret: string,
  shortDate: string,
  region: string,
): Promise<CryptoKey> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), shortDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  return await importHmacKey(kSigning);
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  return await crypto.subtle.sign("HMAC", await importHmacKey(key), encoder.encode(data));
}

async function importHmacKey(key: BufferSource): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

function buildStringToSign(
  amzDate: string,
  credentialScope: string,
  canonicalRequestHash: string,
): string {
  return `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;
}

function buildAuthorizationHeader(
  accessKeyId: string,
  credentialScope: string,
  signedHeaders: string,
  signature: string,
): string {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const MAX_PRESIGN_EXPIRY = 7 * 24 * 60 * 60;

/**
 * Refuses an expiry SigV4 cannot express rather than signing a different one.
 * `X-Amz-Expires` is a whole number of seconds, at most seven days.
 */
function resolveExpiry(value: number = 900): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PRESIGN_EXPIRY) {
    throw new RangeError(
      `Presigned URL expiry must be an integer from 1 to ${MAX_PRESIGN_EXPIRY} seconds, got ${value}.`,
    );
  }
  return value;
}

function formatAmzDate(date: Date): { amzDate: string; shortDate: string } {
  const iso = new Date(date.getTime() - date.getMilliseconds()).toISOString();
  const shortDate = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return {
    amzDate: `${shortDate}T${time}Z`,
    shortDate,
  };
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const baseBuffer = data.buffer;
  const slice =
    data.byteOffset === 0 && data.byteLength === baseBuffer.byteLength
      ? baseBuffer
      : baseBuffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const buffer = await crypto.subtle.digest("SHA-256", slice);
  return toHex(buffer);
}

const _Buffer: BufferConstructor | undefined = /* @__PURE__ */ (() => {
  try {
    return globalThis.Buffer;
  } catch {
    return undefined;
  }
})();
const _hasBuffer: boolean = typeof _Buffer?.from === "function";
const _hasToHex = !_hasBuffer && typeof (Uint8Array.prototype as any).toHex === "function";
function toHex(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  if (_hasBuffer) {
    return _Buffer!.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
  }
  if (_hasToHex) {
    return (bytes as any).toHex();
  }
  return Array.prototype.map.call(bytes, (x: number) => ("00" + x.toString(16)).slice(-2)).join("");
}
