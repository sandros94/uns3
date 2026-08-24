# uns3

[![npm version](https://npmx.dev/api/registry/badge/version/uns3?name=true)](https://npmx.dev/package/uns3)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/uns3)](https://npmx.dev/package/uns3)
[![bundle size](https://npmx.dev/api/registry/badge/size/uns3)](https://npmx.dev/package/uns3)

Tiny, runtime-agnostic, S3 client.

A lightweight, dependency-free S3 client that works across Node, Deno, Bun and modern browsers. Compatible with AWS S3 and S3-compatible providers (Cloudflare R2, Hetzner, Backblaze B2, Garage, etc.). Focused on a small, ergonomic API for streaming downloads, uploads, multipart uploads, presigned URLs and common object operations.

Key features:

- Runtime agnostic: same API in Node, Deno, Bun and browsers
- Works with AWS S3 and S3-compatible endpoints (R2, Hetzner, Backblaze…)
- Streamable responses (standard Response object)
- Multipart upload helpers and presigned URL generation
- Zero native dependencies, minimal bundle size

> [!WARNING]
> This package is in active development. It is not recommended for production use yet unless you are willing to help with testing and feedback.
> Expect breaking changes, as I prioritize usability and correctness over stability at this stage.

## Usage

Install the package:

```bash
# ✨ Auto-detect (supports npm, yarn, pnpm, deno and bun)
npx nypm install uns3
```

Import:

**ESM** (Node.js, Bun, Deno)

```js
import { S3Client, S3Error } from "uns3";
```

**CDN** (Deno, Bun and Browsers)

```js
import { S3Client, S3Error } from "https://esm.sh/uns3";
```

### Initialization

First, create an instance of the `S3Client`. You need to provide your endpoint and credentials. The `region` defaults to `"auto"`, which is accepted by most S3-compatible providers; for AWS, specify the actual region (e.g. `"us-east-1"`).

```typescript
import { S3Client } from "uns3";

const client = new S3Client({
  // e.g. "https://s3.us-east-1.amazonaws.com" or your custom endpoint
  endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
  // region: "us-east-1", // optional, defaults to "auto"
  credentials: {
    accessKeyId: "<ACCESS_KEY_ID>",
    secretAccessKey: "<SECRET_ACCESS_KEY>",
  },
  // Optional default bucket
  defaultBucket: "my-bucket",
});
```

### Methods

All methods return a `Promise`.

#### `get()`

Retrieves an object from an S3 bucket. It returns a standard `Response` object, allowing you to stream the body.

```typescript
// Get a full object
const response = await client.get({ key: "my-file.txt" });
const text = await response.text();
console.log(text);

// Get a partial object (range request)
const partialResponse = await client.get({
  key: "my-large-file.zip",
  range: { start: 0, end: 1023 }, // first 1KB
});
console.log(partialResponse.status); // 206
const chunk = await partialResponse.arrayBuffer();
```

**Expected statuses**

Every method accepts `expectedStatus`; anything else throws an `S3Error`. The defaults are `200`/`206`/`304` for `get()` and `head()`, `200`/`412` for `put()` and `completeMultipart()`, `200`/`204` for `del()`, `200`/`202`/`204` for `abortMultipart()`, and `200` elsewhere. Passing your own value _replaces_ the default rather than adding to it, which is how you teach the client about a store that answers, say, `201` to a PUT:

```typescript
await client.put({ key: "file.txt", body: "hi", expectedStatus: [200, 201] });
```

**Conditional Requests & Caching**

The `get()` and `head()` methods support conditional request headers (`ifMatch`, `ifNoneMatch`, `ifModifiedSince`, `ifUnmodifiedSince`). When the object hasn't changed, S3 returns a `304 Not Modified` response, which is treated as a success.

```typescript
// Conditional GET using ETag
const response = await client.get({
  key: "cached-file.txt",
  ifNoneMatch: '"abc123"', // ETag from previous request
});

if (response.status === 304) {
  console.log("Content hasn't changed, use cached version");
} else {
  // Status is 200, process new content
  const content = await response.text();
}
```

This is especially useful when serving S3 responses through a server framework (e.g., Nitro, Nuxt) to browsers, as the library correctly handles browser cache validation.

#### `head()`

Retrieves metadata from an object without returning the object itself.

```typescript
const response = await client.head({ key: "my-file.txt" });
console.log("Content-Type:", response.headers.get("content-type"));
console.log("ETag:", response.headers.get("etag"));
console.log("Size:", response.headers.get("content-length"));
```

#### `put()`

Uploads an object to an S3 bucket. The `body` can be a `string`, `Blob`, `ArrayBuffer`, `Uint8Array`, or a `ReadableStream`.

```typescript
// Upload from a string
await client.put({
  key: "hello.txt",
  body: "Hello, World!",
  contentType: "text/plain", // also inferred from key extension
});

// Upload from a plain object (automatically stringified)
await client.put({
  key: "hello.json",
  body: {
    message: "Hello, World!",
  },
  // contentType is automatically set to application/json
});

// Upload from a Blob
const blob = new Blob(["<h1>Hello</h1>"], { type: "text/html" });
await client.put({
  key: "index.html",
  body: blob,
});
```

**Streaming uploads**

A `ReadableStream` body is sent as it is produced. Two consequences are worth knowing: it is signed as `UNSIGNED-PAYLOAD` and cannot be checksummed (hashing it would mean buffering it, which is the thing a stream avoids), and it is never retried — the stream is consumed by the attempt that sent it, so there is nothing left to send a second time.

Most stores also want a length. With none, the body goes out as `Transfer-Encoding: chunked`, which AWS S3 and several S3-compatible stores answer with `411 MissingContentLength`. Declare it with `contentLength` whenever you know it:

```typescript
await client.put({
  key: "large.bin",
  body: stream,
  contentLength: byteLength,
});
```

The value is signed along with the rest of the request, so it has to be the real byte length: too small and the store rejects the signature or the body, too large and the connection waits for bytes that never arrive and fails as a bare `fetch failed`. Neither is retried, because a PUT is not idempotent. `uploadPart()` takes the same option, for the same reason.

**Object keys**

Keys are sent as written, with one exception the runtime forces: a key containing a `.` or `..` **path segment** (`dir/../evil.txt`, `a/./b`) is rejected. Every URL parser — and therefore every `fetch` — deletes dot segments while parsing, so such a key cannot be put on the wire at all; it used to be silently rewritten into a different key, which is worse than an error. Dots inside a name (`archive.tar.gz`, `c..d`) are ordinary characters and are untouched.

**Conditional Overwrites (Advanced)**

The `put()` method supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for preventing accidental overwrites. Note that not all S3-compatible providers support these headers.

```typescript
// Only overwrite if the current ETag matches
const response = await client.put({
  key: "document.txt",
  body: "Updated content",
  ifMatch: '"abc123"', // Current object's ETag
});

if (response.status === 412) {
  console.log("Precondition failed - object was modified by someone else");
} else {
  console.log("Upload successful");
}
```

When conditional headers are used and the condition fails, S3 returns `412 Precondition Failed` (not `304 Not Modified` like GET/HEAD operations).

#### `del()`

Deletes an object from a bucket. Note: DELETE operations do not support conditional headers.

```typescript
await client.del({ key: "my-file-to-delete.txt" });
```

#### `list()`

Lists objects in a bucket.

```typescript
const result = await client.list({
  prefix: "documents/",
  delimiter: "/", // To group objects by folder
});

console.log("Files:", result.contents);
// [ { key: 'documents/file1.txt', ... }, ... ]

console.log("Subdirectories:", result.commonPrefixes);
// [ 'documents/images/', ... ]
```

Pagination follows `nextContinuationToken` for as long as `isTruncated` is `true`. A store that ignores `list-type=2` and answers V1-style pagination instead reports `nextMarker`, which is not a continuation token and does not work as one — pass it back as `query: { marker }`:

```typescript
let token: string | undefined;
do {
  const page = await client.list({ prefix: "documents/", continuationToken: token });
  token = page.isTruncated ? page.nextContinuationToken : undefined;
} while (token);
```

#### `getSignedUrl()`

Generates a presigned URL that can be used to grant temporary access to an S3 object.

```typescript
// Get a presigned URL for downloading an object (expires in 1 hour)
const downloadUrl = await client.getSignedUrl({
  method: "GET",
  key: "private-document.pdf",
  expiresInSeconds: 3600,
});
console.log("Download URL:", downloadUrl);

// Get a presigned URL for uploading an object
const uploadUrl = await client.getSignedUrl({
  method: "PUT",
  key: "new-upload.zip",
  expiresInSeconds: 600, // 10 minutes
});
console.log("Upload URL:", uploadUrl);
```

### Multipart Upload

For large files, you can use multipart uploads.

#### 1. `initiateMultipart()`

Start a new multipart upload and get an `uploadId`.

```typescript
const { uploadId } = await client.initiateMultipart({
  key: "large-video.mp4",
  contentType: "video/mp4",
});
```

#### 2. `uploadPart()`

Upload a part of the file. You need to provide the `uploadId` and a `partNumber` (from 1 to 10,000).

```typescript
const parts = [];
const file = new Blob([/* ... large content ... */]);
const chunkSize = 5 * 1024 * 1024; // 5MB

for (let i = 0; i * chunkSize < file.size; i++) {
  const partNumber = i + 1;
  const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);

  const { etag } = await client.uploadPart({
    uploadId,
    key: "large-video.mp4",
    partNumber,
    body: chunk,
  });

  parts.push({ partNumber, etag });
}
```

#### 3. `completeMultipart()`

Finish the multipart upload after all parts have been uploaded.

```typescript
await client.completeMultipart({
  uploadId,
  key: "large-video.mp4",
  parts: parts,
});
```

**Conditional Overwrites (Advanced)**

The `completeMultipart()` method supports optional conditional headers (`ifMatch`, `ifNoneMatch`) for preventing accidental overwrites. Note that not all S3-compatible providers support these headers.

```typescript
// Only overwrite if the current ETag matches
const response = await client.completeMultipart({
  uploadId,
  key: "large-video.mp4",
  parts: parts,
  ifMatch: '"abc123"', // Current object's ETag
});

if (response.status === 412) {
  console.log("Precondition failed - object was modified by someone else");
} else {
  console.log("Upload successful");
}
```

When conditional headers are used and the condition fails, S3 returns `412 Precondition Failed` (not `304 Not Modified` like GET/HEAD operations).

#### `abortMultipart()`

If something goes wrong, you can abort the multipart upload to clean up the parts that have already been uploaded.

```typescript
await client.abortMultipart({
  uploadId,
  key: "large-video.mp4",
});
```

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm test`

</details>

## Credits

- `mrmime` by [Luke Edwards](https://github.com/lukeed/mrmime).

## License

<!-- automd:contributors license=MIT -->

Published under the [MIT](https://github.com/sandros94/uns3/blob/main/LICENSE) license.
Made by [community](https://github.com/sandros94/uns3/graphs/contributors) 💛
<br><br>
<a href="https://github.com/sandros94/uns3/graphs/contributors">
<img src="https://contrib.rocks/image?repo=sandros94/uns3" />
</a>

<!-- /automd -->

<!-- automd:with-automd -->

---

_🤖 auto updated with [automd](https://automd.unjs.io)_

<!-- /automd -->
