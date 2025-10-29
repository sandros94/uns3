Design a runtime-agnostic, minimal-deps, S3-compatible client with strong defaults, streaming-first I/O, and a single master class that coordinates internal utilities. Focus on AWS S3 compatibility across providers; avoid vendor-specific features. No shims; require modern runtimes (Web Crypto available).

### High-level architecture

- Core: a master `S3Client` that holds config and composes small, testable utility modules.
- Transport: fetch-only, no Node/Bun/Deno-specific APIs. Use Web Streams where available. On Node, rely on built-in fetch/Web Crypto.
- Signing: internal SigV4 signer with both header-signed and query (pre-signed) modes.
- Streaming-first: never auto-buffer large payloads; provide optional helpers to decode bodies.
- Strict S3 semantics: map methods to S3 REST API and ListObjectsV2; avoid AWS-only extras.

### Core requirements

- Cross-runtime:
  - Uses `fetch`, `URL`, `Headers`, Web Crypto (SubtleCrypto), Web Streams.
  - Avoid Buffer, Node streams, `fs`, and process-specific APIs.
- Minimal dependencies:
  - Optional: `mrmime` for Content-Type lookups (pluggable resolver; default uses `mrmime`).
  - Everything else internal.
- Config:
  - Region, endpoint, credentials, bucket resolution style, default headers (cache-control, content-type resolver).
  - Defaults geared for correctness: always set Host/date headers, default `UNSIGNED-PAYLOAD` for presign, default content-type fallback using `mrmime`.
  - Per-call overrides on headers, query params, and checksum behavior.
- Error model:
  - Surface structured errors with:
    - name/code (HTTP status + S3 error code if present)
    - requestId/extendedRequestId from S3 headers
    - retriable flag suggestion (initially basic; improved in phase 2).
- Strict streaming:
  - Expose raw Response/ReadableStream for GET/PUT when appropriate.

### Supported operations (target parity with S3 REST)

- Reads:
  - GET object (stream or pre-signed URL)
  - HEAD object (metadata)
  - Range GET (phase 2)
  - Conditional GET (If-\* headers, phase 2)
- Writes:
  - PUT object (single-part)
  - DELETE object
- Listing:
  - ListObjectsV2 with prefix/delimiter (pagination)
- Multi-part (phase 3):
  - Initiate multipart
  - Upload part(s) with parallel uploads
  - Complete/Abort multipart
- Presigning:
  - GET/HEAD/PUT
  - Presign upload part (for browser direct multipart)
- Utilities:
  - Content-Type resolution using key/override/mrmime
  - ETag/MD5 note: S3 ETag is not always MD5; avoid assuming integrity by ETag. Checksum supplements in phase 2.

### API shape (methods exposed by master class)

- get, head, put, del, list, getSignedUrl
- multipart: initiate, uploadPart, complete, abort
- Helpers: decode (text/json/arrayBuffer), contentTypeForKey

### Configuration model

- S3Client config:
  - endpoint: string
  - credentials: { accessKeyId, secretAccessKey, sessionToken? } | provider fn
  - bucketStyle: "virtual" | "path" (phase 2)
  - defaultBucket?: string
  - contentTypeResolver?: (key, override?) => string | undefined
  - fetch?: typeof fetch (override for tests)
  - clockSkewMs?: number (phase 2)
  - retry?: { maxAttempts, backoff, retriableErrorFn } (phase 2)
  - checksum?: { algorithm: "sha256" | "crc32c" | "none"; requireOnPut?: boolean } (phase 2)
- Per-call options:
  - bucket, key, headers, query, expectedStatus?
  - responseType?: "response" | "stream" (by default "response")
  - signal?: AbortSignal
  - contentType?: string | false (false disables resolver)
  - cacheControl?, contentDisposition?, contentEncoding?

### Internal modules

- Endpoint resolver:
  - Builds request URL from endpoint, bucket, key, style (virtual/path).
  - Encodes keys correctly (RFC 3986); keep “/” as path separator.
- SigV4 signer:
  - Canonical request builder: method, canonical URI, canonical query, canonical headers, signed headers, payload hash.
  - String-to-sign, credential scope, derived signing key.
  - Header signing and query signing (presign).
  - Supports `UNSIGNED-PAYLOAD` (GET/HEAD or PUT presign), and SHA-256 of body for non-presign PUTs (phase 2: optional).
- Serializer:
  - Request construction with headers (host, x-amz-date, x-amz-security-token)
  - Payload hashing policy: MVP prefer `UNSIGNED-PAYLOAD` for presigned; for header-signed PUT choose between hashing or unsigned payload when allowed by providers you target.
- Transport:
  - Fetch wrapper that:
    - never reads body unless requested
    - returns Response as-is
    - attaches request metadata for error reporting
- Error parser:
  - Parse S3 XML error bodies (without auto-buffering by default; only when status >= 400 and content-length is reasonable).
  - Extract x-amz-request-id, x-amz-id-2, code/message.
- Pagination helper:
  - Async iterator for ListObjectsV2 with continuation tokens.
- Content-Type:
  - Resolver chain: explicit override -> `mrmime` by key -> undefined.
- Range/conditional builder (phase 2):
  - Utilities to add `Range`, `If-None-Match`, etc.

### Implementation phases and scope

1. MVP: core functionality + defaults/overrides

- Implement:
  - get, head, put, del
  - list (ListObjectsV2 basic)
  - getSignedUrl (GET/PUT/HEAD)
- Defaults:
  - content-type: resolve via resolver (`mrmime`) when missing and method is PUT
  - do not compute checksums by default
  - do not retry by default; expose `signal`
  - no auto-buffering; expose Response
- Tests:
  - Against a known S3-compatible (MinIO, Hetzner, AWS)
  - Cases: put+get roundtrip; metadata presence; list with prefix+delimiter; presign GET and fetch via browser.

2. Advanced HTTP and robustness

- Features:
  - Checksum optional policy (SHA-256 hashing on PUT only when enabled and body is small enough)
  - Path-style vs virtual-hosted style selection, plus automatic fallback when bucket name is not DNS-compliant
  - Range GET and conditional requests (If-*, If-None-Match, If-Modified-Since)
  - Basic retry policy with exponential backoff for 5xx, throttling, and idempotent GET/HEAD
  - Clock skew correction using Date and server Date headers
- Tests:
  - Conditional GET 304 handling
  - Range GET correctness and partial content headers
  - Retry/backoff behavior under simulated 5xx

3. Multipart support

- Flow:
  - initiateMultipartUpload -> returns uploadId
  - uploadPart (N calls, parallelizable) -> returns ETag per part
  - completeMultipartUpload with partNumber+ETag list
  - abortMultipartUpload
- Policies:
  - Default part size 8–16 MiB; allow override; validate minimum 5 MiB except last part
  - Parallel upload helper (optional utility) taking a stream/source and yielding progress
  - No implicit buffering of entire file; for browsers, rely on Blob.slice streams; for Node/Bun/Deno, use ReadableStream if available
- Edge cases:
  - Retry individual part PUTs
  - Preserve part order for completion payload
- Tests:
  - Various payload sizes across boundaries (exact 5 MiB, N*partSize, final smaller part)
  - Abort on failure

4. Additional non-vendor-specific enhancements

- Robust error decoding with small-body XML parsing; cap error read size to e.g., 64 KiB
- Content-Disposition helpers (inline/attachment + safe filename)
- URL encoding policy correctness (e.g., `+` vs `%2B`)
- Safe key utilities (join, normalize, guard against accidental leading slashes)
- Simple policy-based redirects:
  - For downloads: option to return presigned URL rather than proxying
- Pluggable auth provider:
  - Static creds object or async provider function; future-friendly for web Identity providers
- Metrics hooks:
  - Optional callbacks for request start/end with timings and bytes sent/received (no heavy deps)

### Performance and memory policies

- Never auto-buffer large bodies
- Only compute checksums when enabled AND:
  - data is small and available as ArrayBuffer/Uint8Array/Blob, or
  - you’re okay doing a pass over a stream (warn: CPU-heavy, can add latency)
- For multipart, read/pipe in chunk-sized windows only
- Respect backpressure via Web Streams where supported

### Compatibility notes for S3 providers

- ETag ≠ MD5 for multipart; document clearly
- Virtual-hosted style may be unsupported for non-DNS-compliant buckets; add path-style fallback (phase 2)
- Unsigned payload for presigned URLs is widely accepted for GET/HEAD and PUT presigns

### Security considerations

- Never log credentials or signed headers
- Limit presign expiry (e.g., default 900s)
- Consider canonical header set minimalism: sign only necessary headers; include any you add (content-type, content-md5 if used)
- Normalize header casing; lower-case canonicalization in signer

### Testing strategy

- Unit tests for:
  - Canonical request, string-to-sign, signature (with known-good vectors)
  - Endpoint and path construction
  - Query canonicalization/sorting/encoding
- Integration tests:
  - Real object store (MinIO/AWS/Hetzner) with test bucket
  - Browser environment test for presigned PUT
- Fuzz/special cases:
  - Keys with spaces, unicode, `+`, `?`, `#`, consecutive slashes
  - Empty objects, zero-length PUT/GET
  - Large objects via multipart

### Documentation outline

- Getting started (runtime support, minimal example)
- Configuration and defaults
- Streaming philosophy and helpers
- Presigning guide (download/upload)
- Multipart cookbook (with and without client-side parallelization)
- Provider compatibility notes
- Error handling patterns

### Minimal TypeScript interfaces (examples)

```ts
export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type CredentialsProvider = () => Promise<Credentials>;

export type BucketStyle = "virtual" | "path";

export interface S3ClientConfig {
  endpoint: string; // e.g. https://s3.eu-central-1.amazonaws.com or provider host
  credentials: Credentials | CredentialsProvider;
  defaultBucket?: string;
  bucketStyle?: BucketStyle; // default 'virtual'
  fetch?: typeof fetch;
  contentTypeResolver?: (key: string, explicit?: string) => string | undefined;
  clockSkewMs?: number;
  retry?: {
    maxAttempts: number;
    baseDelayMs: number;
    jitter?: boolean;
    retriable?: (res: Response | undefined, err: unknown) => boolean;
  };
  checksum?: {
    algorithm: "none" | "sha256" | "crc32c";
    requireOnPut?: boolean;
  };
}

export interface GetObjectParams {
  bucket?: string;
  key: string;
  range?: { start?: number; end?: number }; // phase 2
  ifNoneMatch?: string; // phase 2
  ifModifiedSince?: Date; // phase 2
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface PutObjectParams {
  bucket?: string;
  key: string;
  body: Blob | ArrayBufferView | ArrayBuffer | ReadableStream<Uint8Array>;
  contentType?: string | false;
  cacheControl?: string;
  contentDisposition?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface ListParams {
  bucket?: string;
  prefix?: string;
  delimiter?: string;
  continuationToken?: string;
  maxKeys?: number;
}

export interface PresignParams {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  bucket?: string;
  key: string;
  expiresInSeconds?: number; // default 900
  headers?: HeadersInit;
  query?: Record<string, string>;
}

export interface MultipartInitParams {
  bucket?: string;
  key: string;
  contentType?: string | false;
  headers?: HeadersInit;
}

export interface UploadPartParams {
  bucket?: string;
  key: string;
  uploadId: string;
  partNumber: number; // 1..N
  body: Blob | ArrayBufferView | ArrayBuffer | ReadableStream<Uint8Array>;
  contentLength?: number; // helpful for some providers/runtimes
  signal?: AbortSignal;
}

export interface CompleteMultipartParams {
  bucket?: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}

export interface AbortMultipartParams {
  bucket?: string;
  key: string;
  uploadId: string;
}

export interface S3Client {
  get(params: GetObjectParams): Promise<Response>;
  head(params: {
    bucket?: string;
    key: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }): Promise<Response>;
  put(params: PutObjectParams): Promise<Response>;
  del(params: {
    bucket?: string;
    key: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
  }): Promise<Response>;
  list(params: ListParams): Promise<{
    contents: Array<{
      key: string;
      size: number;
      etag: string;
      lastModified: string;
    }>;
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  }>;
  getSignedUrl(params: PresignParams): Promise<string>;

  // Multipart (phase 3)
  initiateMultipart(params: MultipartInitParams): Promise<{ uploadId: string }>;
  uploadPart(params: UploadPartParams): Promise<{ etag: string }>;
  completeMultipart(params: CompleteMultipartParams): Promise<Response>;
  abortMultipart(params: AbortMultipartParams): Promise<void>;
}
```

### Project structure

- src/
  - index.ts (exports S3Client and namespaced core and utils)
  - client.ts (S3Client class implementation)
  - core/
    - endpoint.ts (endpoint resolver)
    - signer.ts (SigV4 signing logic)
    - transport.ts (fetch wrapper)
    - serializer.ts (request builder)
    - errorParser.ts (S3 error XML parser)
    - paginator.ts (ListObjectsV2 paginator)
    - contentType.ts (content-type resolver)
  - utils/
    - mime.ts (mrmime fork)
    - keyUtils.ts
    - urlEncoding.ts
    - checksum.ts
    - multipartHelper.ts (optional parallel upload helper)

Each type and interface should be defined and exported in most relevant files.

### Phase-by-phase task list (actionable)

- Phase 1 (MVP)
  1. Implement endpoint builder + bucket style
  2. Implement canonical query/header encoders
  3. Implement SigV4 for headers and presign (GET/HEAD/PUT)
  4. Implement transport wrapper returning Response
  5. Implement get/head/put/del/list
  6. Add `getSignedUrl`
  7. Add content-type resolver and default `mrmime` usage
  8. Integration tests on one S3-compatible backend

- Phase 2 (HTTP extras)
  1. Range and conditional request support
  2. Path vs virtual style toggle + fallback for non-DNS buckets
  3. Basic retry policy + clock skew handling
  4. Optional checksum policy (small bodies; warn about CPU cost)
  5. Error parsing and structured error object

- Phase 3 (Multipart)
  1. Implement initiate/uploadPart/complete/abort
  2. Parallel upload helper (optional) that respects memory limits
  3. Tests for boundary sizes, retries per part, abort flows

- Phase 4 (Nice-to-haves)
  1. Content-Disposition helpers
  2. Metrics hooks
  3. Async credentials provider support
  4. Docs with provider matrix and caveats
