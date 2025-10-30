import type { Credentials, Methods } from "../types";
import {
  uriEncode,
  isArrayBuffer,
  isArrayBufferView,
  isBlob,
  isReadableStream,
} from "../utils";

const encoder = new TextEncoder();
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface SignRequestInput {
  method: Methods;
  url: URL;
  region: string;
  credentials: Credentials;
  headers?: Headers;
  body?: BodyInit | ReadableStream<Uint8Array> | null;
  datetime?: Date;
  unsignedPayload?: boolean;
}

export interface SignRequestResult {
  headers: Headers;
  payloadHash: string;
  amzDate: string;
  signedHeaders: string;
}

export interface PresignInput {
  method: Methods;
  url: URL;
  region: string;
  credentials: Credentials;
  headers?: Headers;
  datetime?: Date;
  expiresInSeconds?: number;
  unsignedPayload?: boolean;
}

export interface PresignResult {
  url: URL;
  payloadHash: string;
  amzDate: string;
  signedHeaders: string;
}

/**
 * Produces SigV4 signed headers for a request and returns auxiliary metadata.
 *
 * @param input - Method, URL, credentials, headers, body, and signing options.
 */
export async function signRequest(
  input: SignRequestInput,
): Promise<SignRequestResult> {
  const { credentials, region } = input;
  const date = input.datetime ?? new Date();
  const { amzDate, shortDate } = formatAmzDate(date);
  const headers = cloneHeaders(input.headers);

  ensureHost(headers, input.url);
  headers.set("x-amz-date", amzDate);

  if (credentials.sessionToken) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }

  const payloadHash = await resolvePayloadHash(input, headers);
  headers.set("x-amz-content-sha256", payloadHash);

  const { canonical, signedHeaders } = canonicalizeHeaders(headers);
  const canonicalRequest = buildCanonicalRequest(
    input.method,
    input.url,
    canonical,
    signedHeaders,
    payloadHash,
  );

  const canonicalRequestHash = await sha256Hex(
    encoder.encode(canonicalRequest),
  );
  const credentialScope = `${shortDate}/${region}/${SERVICE}/aws4_request`;

  const stringToSign = buildStringToSign(
    amzDate,
    credentialScope,
    canonicalRequestHash,
  );
  const signature = await calculateSignature(
    credentials.secretAccessKey,
    shortDate,
    region,
    stringToSign,
  );
  const authorization = buildAuthorizationHeader(
    credentials.accessKeyId,
    credentialScope,
    signedHeaders,
    signature,
  );
  headers.set("authorization", authorization);

  return {
    headers,
    payloadHash,
    amzDate,
    signedHeaders,
  };
}

/**
 * Generates a SigV4 presigned URL by appending the signature parameters to the
 * provided URL without mutating the original instance.
 *
 * @param input - Method, URL, credentials, headers, and expiry configuration.
 */
export async function presignUrl(input: PresignInput): Promise<PresignResult> {
  const { credentials, region } = input;
  const date = input.datetime ?? new Date();
  const { amzDate, shortDate } = formatAmzDate(date);
  const headers = cloneHeaders(input.headers);
  ensureHost(headers, input.url);

  if (credentials.sessionToken) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }

  const payloadHash = await resolvePresignPayloadHash(input);

  const { canonical, signedHeaders } = canonicalizeHeaders(headers);
  const credentialScope = `${shortDate}/${region}/${SERVICE}/aws4_request`;
  const credential = `${credentials.accessKeyId}/${credentialScope}`;

  const expires = clampExpiry(input.expiresInSeconds ?? 900);
  const presignedUrl = new URL(input.url.toString()); // Prevent mutation
  const search = presignedUrl.searchParams;
  search.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  search.set("X-Amz-Credential", credential);
  search.set("X-Amz-Date", amzDate);
  search.set("X-Amz-Expires", String(expires));
  search.set("X-Amz-SignedHeaders", signedHeaders);

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

  const canonicalRequestHash = await sha256Hex(
    encoder.encode(canonicalRequest),
  );
  const stringToSign = buildStringToSign(
    amzDate,
    credentialScope,
    canonicalRequestHash,
  );
  const signature = await calculateSignature(
    credentials.secretAccessKey,
    shortDate,
    region,
    stringToSign,
  );
  presignedUrl.searchParams.set("X-Amz-Signature", signature);

  return {
    url: presignedUrl,
    payloadHash,
    amzDate,
    signedHeaders,
  };
}

// #region Internal

async function resolvePayloadHash(
  input: SignRequestInput,
  headers: Headers,
): Promise<string> {
  if (input.unsignedPayload) return UNSIGNED_PAYLOAD;

  const existing = headers.get("x-amz-content-sha256");
  if (existing) return existing;

  if (!input.body) {
    return await sha256Hex(encoder.encode(""));
  }

  if (typeof input.body === "string") {
    return await sha256Hex(encoder.encode(input.body));
  }

  if (isArrayBuffer(input.body)) {
    return await sha256Hex(new Uint8Array(input.body));
  }

  if (isArrayBufferView(input.body)) {
    return await sha256Hex(
      new Uint8Array(
        input.body.buffer,
        input.body.byteOffset,
        input.body.byteLength,
      ),
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

async function resolvePresignPayloadHash(input: PresignInput): Promise<string> {
  if (input.unsignedPayload) return UNSIGNED_PAYLOAD;
  if (input.method === "GET" || input.method === "HEAD")
    return UNSIGNED_PAYLOAD;
  return await sha256Hex(encoder.encode(""));
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

function canonicalizeHeaders(headers: Headers): {
  canonical: string;
  signedHeaders: string;
} {
  const headerMap = new Map<string, string[]>();

  // eslint-disable-next-line unicorn/no-array-for-each
  headers.forEach((value, key) => {
    const lower = key.trim().toLowerCase();
    if (!lower) {
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
  const canonical = sortedKeys
    .map((key) => `${key}:${headerMap.get(key)!.join(",")}`)
    .join("\n");
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

function getCanonicalUri(pathname: string): string {
  if (!pathname) return "/";
  const encodedPath = pathname
    .split("/")
    .map((part) => uriEncode(part))
    .join("/");
  return encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;
}

function getCanonicalQuery(params: URLSearchParams): string {
  const entries: Array<{ key: string; value: string }> = [];
  for (const [key, value] of params) {
    entries.push({ key, value });
  }
  entries.sort((a, b) =>
    a.key === b.key
      ? a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : 0
      : a.key < b.key
        ? -1
        : 1,
  );
  return entries
    .map(
      (entry) =>
        `${uriEncode(entry.key, true)}=${uriEncode(entry.value, true)}`,
    )
    .join("&");
}

async function calculateSignature(
  secretAccessKey: string,
  shortDate: string,
  region: string,
  stringToSign: string,
): Promise<string> {
  const kDate = await hmac(`AWS4${secretAccessKey}`, shortDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const rawSignature = await hmac(kSigning, stringToSign);
  return toHex(rawSignature);
}

async function hmac(
  key: string | ArrayBuffer,
  data: string,
): Promise<ArrayBuffer> {
  const keyData = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
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

function clampExpiry(value: number): number {
  return Math.min(Math.max(value, 1), MAX_PRESIGN_EXPIRY);
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

function toHex(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);

  // @ts-expect-error check if toHex is available
  if (Uint8Array.prototype.toHex) {
    // @ts-expect-error
    return bytes.toHex();
  }

  return Array.prototype.map
    .call(bytes, (x: number) => ("00" + x.toString(16)).slice(-2))
    .join("");
}
