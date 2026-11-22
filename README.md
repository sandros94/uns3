# uns3

[![npm version](https://npmx.dev/api/registry/badge/version/uns3?name=true)](https://npmx.dev/package/uns3) [![npm downloads](https://npmx.dev/api/registry/badge/downloads/uns3)](https://npmx.dev/package/uns3) [![bundle size](https://npmx.dev/api/registry/badge/size/uns3)](https://npmx.dev/package/uns3)

A small S3 client with no dependencies, for Node, Deno, Bun and browsers. It works with AWS S3 and S3-compatible stores such as Cloudflare R2, Hetzner, Backblaze B2 and Garage, using only `fetch` and Web Crypto.

Key features:

- The same API in every runtime, with responses as standard `Response` objects you can stream
- Reads, writes, listings, multipart uploads and presigned URLs
- Retries with backoff, per-attempt timeouts and clock skew correction
- Subpath imports, so a bundle holds only what you use

## Install

Install the package:

```bash
npx nypm install uns3
```

In Deno or a browser without a bundler, import it from a content delivery network (CDN):

```typescript
import { S3Client } from "https://esm.sh/uns3";
```

## Create a client

A client needs the store's endpoint and your credentials. Set `region` for AWS. S3-compatible stores accept the default, `"auto"`.

```typescript
import { S3Client } from "uns3";

const client = new S3Client({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  credentials: {
    accessKeyId: "your_access_key_id",
    secretAccessKey: "your_secret_access_key",
  },
  defaultBucket: "my-bucket",
});
```

Every request takes a `bucket`, and falls back to `defaultBucket` when it has none. The other options are:

- `credentials` can also be a function, sync or async, that the client calls before every request. Leave it out to send requests unsigned.
- `bucketStyle`: `"virtual"` (the default) puts the bucket in the host name, `"path"` in the path. Virtual style falls back to path style where a subdomain cannot work: bucket names that are not DNS-compatible, dotted names over HTTPS, and IP or `localhost` endpoints.
- `checksum`: `{ algorithm: "sha256" | "crc32c" }` adds an integrity checksum to every `put` and `uploadPart` body that can be hashed. Add `requireOnPut: true` to refuse a body that cannot be, a stream or a Blob over 16 MiB, instead of sending it without one.
- `clockSkewMs`: milliseconds added to the local clock when signing. The client also corrects its clock once the store's is five minutes or more away.
- `retry` and `timeoutMs`: see [Retries and timeouts](#retries-and-timeouts).
- `contentTypeResolver`: how the content type of an upload is inferred from its key, see [Infer content types](#infer-content-types).
- `signingKeyCache`: where derived signing keys are kept, see [Isolate signing key caches](#isolate-signing-key-caches).
- `fetch`: the `fetch` requests are sent with, `globalThis.fetch` by default.

## Read objects

`get()` resolves with the store's `Response` once its headers arrive. Read the body as a stream with `response.body`, or all at once with `text()`, `json()` or `arrayBuffer()`:

```typescript
const response = await client.get({ key: "hello.txt" });
const text = await response.text();
```

A `range` reads part of an object, and the response is a `206`. Pass `start`, `end` or both, zero-based and inclusive, or `suffix` for the last bytes:

```typescript
const first = await client.get({ key: "big.zip", range: { end: 1023 } });
const tail = await client.get({ key: "big.zip", range: { suffix: 1024 } });
```

`head()` reads only the metadata, as response headers. A missing object throws an `S3Error` with `status` `404`:

```typescript
const response = await client.head({ key: "hello.txt" });
const size = Number(response.headers.get("content-length"));
```

Both methods take conditions: `ifMatch`, `ifNoneMatch`, `ifModifiedSince` and `ifUnmodifiedSince`. When the object has not changed, the store answers `304 Not Modified`, which counts as success. A server can pass a browser's cache validators through this way:

```typescript
const response = await client.get({ key: "logo.svg", ifNoneMatch: etag });

if (response.status === 304) {
  // the copy the caller holds is current
}
```

## Write objects

`put()` writes an object, replacing any object with the same key. The body can be a string, a `Blob`, an `ArrayBuffer`, a typed array, a `ReadableStream`, or a plain object or array, which is sent as JSON:

```typescript
await client.put({ key: "hello.txt", body: "Hello, world!" });
await client.put({ key: "data.json", body: { hello: "world" } });

const blob = new Blob(["<h1>Hello</h1>"], { type: "text/html" });
await client.put({ key: "index.html", body: blob });
```

The content type is `contentType`, else a `content-type` header, else the body's own type (a Blob's, or JSON for a plain object), else the one inferred from the key's extension. `contentType: false` sends none.

### Stream an upload

A `ReadableStream` body is sent as it is produced, without a payload signature or a checksum. It is never retried, since the first attempt consumed it. AWS S3 and several other stores refuse a stream of unknown length with `411 MissingContentLength`, so pass `contentLength` when you know it:

```typescript
await client.put({ key: "large.bin", body: stream, contentLength: size });
```

The length is signed, so it must be exact: a wrong value fails the request. A runtime whose `fetch` cannot stream a request body, such as Firefox, refuses a stream body with a `TypeError` before anything is sent. Pass a `Blob` or a buffer there instead.

### Write only under a condition

`ifNoneMatch: "*"` writes only if no object exists under the key yet, and `ifMatch` overwrites only the version with that entity tag (ETag). A failed condition throws an `S3Error` with `status` `412`:

```typescript
import { S3Error } from "uns3";

try {
  await client.put({ key: "doc.txt", body: "v2", ifMatch: etag });
} catch (error) {
  if (!(error instanceof S3Error) || error.status !== 412) throw error;
  // someone changed the object since you read it
}
```

ETags are always quoted (`"abc123"`), whichever method returned them, so you can pass a listed or uploaded one to `ifMatch` as it is. Not every S3-compatible store supports conditional writes.

### How keys are sent

Keys are sent as written: `/a.txt` and `a.txt` are two different objects. A key with a `.` or `..` path segment, such as `dir/../evil.txt`, throws instead: every URL parser removes such segments, so the request would write to another key. Dots inside a name, such as `archive.tar.gz`, are kept.

## Delete objects

`del()` deletes an object. Deleting a key that does not exist succeeds too:

```typescript
await client.del({ key: "hello.txt" });
```

## List objects

`list()` lists a bucket one page at a time. `prefix` limits it to keys that start with that string, and `delimiter` groups keys into `commonPrefixes`, such as folders:

```typescript
const page = await client.list({ prefix: "photos/", delimiter: "/" });

for (const object of page.contents) console.log(object.key, object.size);
console.log(page.commonPrefixes); // ["photos/2024/", "photos/2025/"]
```

While `isTruncated` is `true`, more pages follow. Pass `nextContinuationToken` back as `continuationToken`. A store that pages the older (V1) way reports `nextMarker` instead, which goes back as `query: { marker }`:

```typescript
let token: string | undefined;
let marker: string | undefined;
do {
  const page = await client.list({
    prefix: "photos/",
    continuationToken: token,
    query: marker ? { marker } : undefined,
  });
  token = page.isTruncated ? page.nextContinuationToken : undefined;
  marker = page.isTruncated && !token ? page.nextMarker : undefined;
} while (token || marker);
```

## Share objects with presigned URLs

`getSignedUrl()` creates a link that authorizes one method on one object until it expires, with no other credentials. Nothing is sent to the store:

```typescript
const download = await client.getSignedUrl({
  method: "GET",
  key: "report.pdf",
  expiresInSeconds: 3600,
});
const upload = await client.getSignedUrl({ method: "PUT", key: "in.zip" });
```

`expiresInSeconds` is 900 (15 minutes) by default, and must be an integer from 1 to 604800 (seven days). Anything else throws a `RangeError`.

The URL works as a plain link, in an `<img>`, or with `curl`. A presigned `PUT` accepts any body. Headers you pass in `headers` are signed, and whoever uses the URL must send them with the same values.

## Upload large objects in parts

A multipart upload sends an object in parts, which you can upload in any order and in parallel. On AWS S3, every part but the last must be at least 5 MiB. Start the upload with `initiateMultipart()`, and send each part with `uploadPart()`:

```typescript
const key = "video.mp4";
const { uploadId } = await client.initiateMultipart({ key });

const partSize = 8 * 1024 * 1024;
const count = Math.ceil(file.size / partSize);
const parts = [];
for (let partNumber = 1; partNumber <= count; partNumber++) {
  const body = file.slice((partNumber - 1) * partSize, partNumber * partSize);
  const part = await client.uploadPart({ key, uploadId, partNumber, body });
  parts.push({ ...part, partNumber });
}
```

`uploadPart()` resolves with the part's `etag`, and its `checksum` when one is configured. Keep them with the part number: `completeMultipart()` takes that list and assembles the object:

```typescript
const { etag } = await client.completeMultipart({ key, uploadId, parts });
```

S3 can report a failure inside a `200` on this call, so the response is checked, and a failure found there is thrown, or retried when it is transient. `completeMultipart()` takes `ifMatch` and `ifNoneMatch` too. To discard the parts of an upload you will not complete, call `abortMultipart()`:

```typescript
await client.abortMultipart({ key, uploadId });
```

## Infer content types

A client infers content types from 31 common extensions by default: web pages and their assets, the image, audio and video formats browsers play, PDFs, and zip and gzip archives. For other formats, build a resolver from the groups your bucket holds. The bundle then holds only those tables:

```typescript
import { createContentTypeResolver } from "uns3/mime";
import { image } from "uns3/mime/image";
import { data } from "uns3/mime/data";

const client = new S3Client({
  endpoint,
  contentTypeResolver: createContentTypeResolver(image, data, {
    heic: "image/heic",
  }),
});
```

The groups are:

- `common`: the default set, also exported by `uns3/mime`
- `web`: pages, styles, scripts, JSON, feeds and the web manifest
- `image`, `audio`, `video` and `font`: media, video including streaming playlists and segments
- `document`: office documents, PDFs, e-books and plain text
- `data`: Parquet, Arrow, CSV, JSON, YAML, TOML and GeoJSON
- `archive`: zip, tar, gzip, 7z, RAR, xz and zstd
- `model`: 3D models and scenes
- `all`: every group plus the other types the Internet Assigned Numbers Authority (IANA) registers, about 12 KB minified

A later table wins over an earlier one, and a record of your own works like any group. Each group module exports its table by name and as the default.

## Handle errors

When the store answers with a failure, the client throws an `S3Error`. That covers a status the method does not expect, an error inside a `200`, and a document that is not the one requested:

```typescript
import { S3Error } from "uns3";

try {
  await client.get({ key: "missing.txt" });
} catch (error) {
  if (error instanceof S3Error && error.status === 404) {
    // the object does not exist
  }
}
```

An `S3Error` has the answer's `status` and the S3 `code`, such as `"NoSuchKey"` or `"AccessDenied"`. An answer without an error document, such as every `head()`, gets the code its status stands for, such as `"NotFound"`. It also has `requestId` and `extendedRequestId` for AWS support, `retriable`, `retryAfter`, and `bucketRegion` when a request went to the wrong region. A request that never got an answer throws a plain `Error` that names the request, with the last failure as its `cause`.

Each method has default statuses that count as success, and any other throws. `get()` and `head()` accept `200`, `206` and `304`, `del()` accepts `200` and `204`, `abortMultipart()` accepts `200`, `202` and `204`, and every other method accepts `200`. Pass `expectedStatus` to replace the default, for example for a store that answers `201` to a write:

```typescript
await client.put({ key: "a.txt", body: "hi", expectedStatus: [200, 201] });
```

## Retries and timeouts

A failed request is sent again when the failure is transient: a `429`, a `5xx` other than `501` and `505`, a throttling or timeout error code, or a failure in transit. Any request is retried as long as its body can be sent again, which every body but a `ReadableStream` can. The delay doubles on each attempt, with jitter, and the client waits as long as a `Retry-After` from the store asks:

```typescript
const client = new S3Client({
  endpoint,
  retry: {
    maxAttempts: 5, // the first attempt included, 3 by default
    baseDelayMs: 200, // 100 by default
    maxDelayMs: 10_000, // the longest wait, 20000 by default
  },
});
```

`retry.retriable` replaces the default decision with your own. It gets the response, or `undefined` when the request failed in transit, and the error.

Every attempt of `head()`, `del()`, `list()` and the multipart calls but `uploadPart()` has a deadline: `timeoutMs` on the client, 30s by default. A timed-out attempt is retried. `get()`, `put()` and `uploadPart()` move object bytes and have no default deadline, but take `timeoutMs` per request. The deadline ends at the response, so it never cuts off a body you are still reading:

```typescript
await client.get({ key: "big.bin", timeoutMs: 5_000 });
```

Aborting a request's `signal` stops it, retries included, and the request rejects with the signal's reason. Redirects are never followed: a bucket in another region throws an `S3Error` whose `bucketRegion` names it.

## Isolate signing key caches

Signing a request takes five HMAC (hash-based message authentication code) operations to derive a key, then one to sign. The derived key only changes with its credentials, its day and its region, so the client keeps it in a `SigningKeyCache` and reuses it. Every client shares `sharedSigningKeyCache` by default. Give a client a cache of its own to isolate a tenant, a department or a single request:

```typescript
import { SigningKeyCache } from "uns3/signer";

const tenantKeys = new SigningKeyCache({ size: 4 });
const client = new S3Client({
  endpoint,
  credentials,
  signingKeyCache: tenantKeys,
});
```

A cache holds 16 keys by default and drops the one used least recently. Each entry also holds the secret its key came from, so call `delete(accessKeyId)` once you revoke an access key, or `clear()` to drop every key, `sharedSigningKeyCache` included. `signingKeyCache: false` derives a key on every request.

## Sign requests without the client

`uns3/signer` signs requests you send with your own `fetch`, and `uns3/endpoint` builds their URLs. Neither pulls in the client:

```typescript
import { buildRequestUrl } from "uns3/endpoint";
import { signRequest } from "uns3/signer";

const { url, headers } = await signRequest({
  method: "GET",
  url: buildRequestUrl({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucketStyle: "virtual",
    bucket: "my-bucket",
    key: "hello.txt",
  }),
  region: "us-east-1",
  credentials,
  unsignedPayload: true,
});
const response = await fetch(url, { headers });
```

Send the `url` that `signRequest()` returns, not your own: its query is encoded the way it was signed. `presignUrl()` presigns a URL the same way `getSignedUrl()` does.

## Development

<details>

<summary>Local development</summary>

- Clone this repository
- Install the latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) with `corepack enable`
- Install dependencies with `pnpm install`
- Run the tests with `pnpm test`

</details>

## Credits

- `mrmime` by [Luke Edwards](https://github.com/lukeed/mrmime), the source of the IANA-registered types in `uns3/mime/all`

## License

<!-- automd:contributors license=MIT -->

Published under the [MIT](https://github.com/sandros94/uns3/blob/main/LICENSE) license. Made by [community](https://github.com/sandros94/uns3/graphs/contributors) 💛 <br><br> <a href="https://github.com/sandros94/uns3/graphs/contributors"> <img src="https://contrib.rocks/image?repo=sandros94/uns3" /> </a>

<!-- /automd -->

<!-- automd:with-automd -->

---

_🤖 auto updated with [automd](https://automd.unjs.io)_

<!-- /automd -->
