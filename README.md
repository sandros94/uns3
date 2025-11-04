# uns3

<!-- automd:badges bundlephobia style="flat" color="FFDC3B" -->

[![npm version](https://img.shields.io/npm/v/uns3?color=FFDC3B)](https://npmjs.com/package/uns3)
[![npm downloads](https://img.shields.io/npm/dm/uns3?color=FFDC3B)](https://npm.chart.dev/uns3)
[![bundle size](https://img.shields.io/bundlephobia/minzip/uns3?color=FFDC3B)](https://bundlephobia.com/package/uns3)

<!-- /automd -->

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

First, create an instance of the `S3Client`. You need to provide your S3-compatible service's region, endpoint, and your credentials.

```typescript
import { S3Client } from "uns3";

const client = new S3Client({
  // e.g. "us-east-1" or "auto" for R2
  region: "auto",
  // e.g. "https://s3.amazonaws.com" or your custom endpoint
  endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
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
const chunk = await partialResponse.arrayBuffer();
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
const file = new Blob([
  /* ... large content ... */
]);
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
