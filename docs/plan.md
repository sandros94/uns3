Design a runtime-agnostic, minimal-deps, S3-compatible client with strong defaults, streaming-first I/O, and a single master class that coordinates internal utilities. Focus on AWS S3 compatibility across providers; avoid vendor-specific features. No shims; require modern runtimes (Web Crypto available).

### Completed

- **Core client** — `S3Client` class with get, head, put, del, list, getSignedUrl.
- **Multipart** — initiateMultipart, uploadPart, completeMultipart, abortMultipart with part-number validation (1–10 000).
- **SigV4 signing** — header-signed and query-signed (presigned URL) modes via Web Crypto HMAC-SHA256. Presign expiry clamped 1 s – 7 days, default 900 s.
- **Streaming-first** — responses are raw `Response` objects; bodies never auto-buffered; error body reads capped at 64 KiB.
- **Endpoint builder** — virtual-hosted and path-style addressing with automatic fallback for non-DNS-compliant bucket names and IP addresses.
- **RFC 3986 URI encoding** — unreserved chars preserved, `+` → `%2B`, `~` preserved, `/` preserved only in paths, double-encoding prevented via decode-then-encode in canonical URI.
- **Content-type resolver** — embedded mrmime MIME table; resolver chain: explicit override → lookup by key → undefined.
- **Conditional requests** — If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since on get/head/put.
- **Range GET** — `ByteRange` with start/end validation.
- **Retry policy** — exponential backoff with jitter; only GET/HEAD retried by default; custom retriable predicate.
- **Clock skew correction** — auto-detects from server `Date` header, stores offset in ms.
- **Checksum policy** — optional SHA-256 and CRC32C on PUT; streams use `UNSIGNED-PAYLOAD`; `requireOnPut` flag.
- **Structured errors** — `S3Error` with status, code, requestId, extendedRequestId, retriable, retryAfter, region, bucketRegion, cause.
- **Async credentials provider** — static `Credentials` object or `() => Promise<Credentials> | Credentials`.
- **Anonymous requests** — works with undefined credentials (no signing).
- **Plain-object JSON support** — auto-stringification in put() with automatic `application/json` content-type.
- **XML parsing** — regex-based `extractTag`; entity escaping/unescaping for multipart payloads and error bodies.

### Remaining work

Items below are ordered by dependency — later items may depend on earlier ones.

#### 1. Object copy support

Add a `copy(params)` method that issues a PUT with `x-amz-copy-source` header.

- No dependencies on other remaining items.
- Should support conditional copy headers (`x-amz-copy-source-if-match`, etc.).
- Consider metadata-directive (`COPY` vs `REPLACE`).
- Presigned copy is not supported by S3; document this.

#### 2. SSE-C support (Server-Side Encryption with Customer-provided keys)

Support the three SSE-C request headers (`x-amz-server-side-encryption-customer-algorithm`, `-key`, `-key-md5`) on get, head, put, uploadPart, and copy.

- No hard dependency on other items, but if object copy (#1) lands first the SSE-C headers should be wired into copy as well.
- Key must be base64-encoded and MD5 computed via Web Crypto — no new deps needed.
- For copy, also support `x-amz-copy-source-server-side-encryption-customer-*`.

#### 3. Content-Disposition helpers

Utility functions for building safe `Content-Disposition` header values:

- `contentDispositionInline(filename?)` → `inline; filename="…"`
- `contentDispositionAttachment(filename)` → `attachment; filename="…"; filename*=UTF-8''…`
- RFC 6266 / RFC 8187 compliant filename encoding.
- No dependencies on other items.

#### 4. Bucket management

Methods for bucket-level operations: `createBucket`, `deleteBucket`, `listBuckets`.

- No dependencies on other items.
- `createBucket` requires XML body with `LocationConstraint`.
- `listBuckets` returns XML with `<Buckets><Bucket>` structure.
- Provider support varies — document caveats (e.g. R2 does not support CreateBucket via S3 API).

#### 5. Hooks / metrics

Optional callback system for observability:

- `onRequestStart(ctx)` / `onRequestEnd(ctx)` with method, url, duration, bytes, status, retry count.
- Must be zero-cost when no hooks are registered (no allocations on the hot path).
- Depends on nothing, but should be designed after the API surface is stable.

#### 6. Provider compatibility docs

Documentation with a provider matrix (AWS, R2, Hetzner, Backblaze B2, Garage, MinIO) covering:

- Bucket style support (virtual vs path).
- Checksum header support.
- Multipart quirks.
- SSE-C availability.
- Conditional request support.

Depends on: all feature work above should be settled so the matrix is accurate.

### Configuration model

```ts
interface S3ClientConfig {
  region?: string; // defaults to "auto"
  endpoint: string;
  credentials?: Credentials | CredentialsProvider;
  defaultBucket?: string;
  bucketStyle?: "virtual" | "path";
  fetch?: typeof fetch;
  contentTypeResolver?: ContentTypeResolver;
  clockSkewMs?: number;
  retry?: RetryConfig;
  checksum?: ChecksumConfig;
}
```

### Project structure

- src/
  - index.ts, core.ts, utils.ts (entry points)
  - client.ts (S3Client class)
  - error.ts (S3Error)
  - types.ts (all interfaces and type definitions)
  - internal/
    - core/
      - signer.ts, endpoint.ts, serializer.ts, transport.ts, content-type.ts, defaults.ts
    - utils/
      - mime.ts, encode.ts, is.ts

### Performance and memory policies

- Never auto-buffer large bodies.
- Only compute checksums when enabled AND data is available as ArrayBuffer/Uint8Array/Blob; streams use `UNSIGNED-PAYLOAD`.
- For multipart, read/pipe in chunk-sized windows only.
- CRC32C lookup table pre-computed once at module load.
- `toHex()` uses runtime-optimal path (Buffer on Node, Uint8Array.toHex on modern browsers, fallback).

### Security considerations

- Never log credentials or signed headers.
- Presign expiry clamped to AWS maximum (7 days).
- Canonical header set: sign all headers present on the request; lowercase canonicalization.
- Error bodies filtered: sensitive headers excluded from S3Error.
- Error body read capped at 64 KiB to prevent memory exhaustion.

### Testing strategy

- Unit tests: canonical request, string-to-sign, signature (known-good vectors), endpoint/path construction, query canonicalization.
- Integration tests: real object store (MinIO/AWS/Hetzner) with test bucket.
- Special cases: keys with spaces, unicode, `+`, `?`, `#`, consecutive slashes; empty objects; large objects via multipart.
