<!-- NOTE: Keep this file updated as the project evolves. When making architectural changes, adding new patterns, or discovering important conventions, update the relevant sections. -->

## Overview

uns3 is a tiny, zero-dependency, runtime-agnostic S3 client that works across Node.js, Deno, Bun, and browsers. It relies entirely on Web Crypto and Fetch APIs (no native dependencies). Compatible with AWS S3 and S3-compatible providers (Cloudflare R2, Hetzner, Backblaze B2, Garage, etc.).

## Commands

- **Install**: `pnpm install` (pnpm via Corepack, pinned by `packageManager`)
- **Build**: `pnpm build` (obuild)
- **Prepare**: `pnpm dev:prepare` (stub build + git hooks; what CI runs first)
- **Lint**: `pnpm lint` (`oxlint .` then `oxfmt --check .`)
- **Lint fix**: `pnpm fmt` (automd + `oxlint --fix` + `oxfmt`)
- **Type check**: `pnpm typecheck` (`tsc --noEmit`, TypeScript 7 native compiler)
- **Test all**: `pnpm test` (`unit` + `integration`)
- **Unit only**: `pnpm test:unit` (fast; no container runtime needed)
- **Integration only**: `pnpm test:integration` (real stores in containers)
- **Browser only**: `pnpm test:browser` (after `pnpm exec playwright install chromium firefox webkit`)
- **Run a single test**: `pnpm vitest run test/core/signer.test.ts`
- **Run tests in watch**: `pnpm vitest`

## Tests

Three vitest projects, declared in `vitest.config.ts`:

- **`unit`** — everything under `test/` except `test/integration/` and `test/browser/`. Requests are answered by a `fetch` mock, so the suite needs nothing but a process. Keep it that way.
- **`integration`** — `test/integration/`, the same battery run against real S3-compatible stores started as containers with testcontainers. Selected with `UNS3_TEST_STORES` (comma-separated). It needs a container runtime: without one, starting a store fails the suite, as does `pnpm test`. Setting `UNS3_TEST_ENDPOINT` (with `UNS3_TEST_BUCKET`, `UNS3_TEST_ACCESS_KEY_ID`, `UNS3_TEST_SECRET_ACCESS_KEY`, optional `UNS3_TEST_REGION`, `UNS3_TEST_SESSION_TOKEN`, `UNS3_TEST_BUCKET_STYLE`) runs the battery against an existing store instead of the containers, and needs no container runtime. These may live in a local `.env`. The leg deletes what it wrote when it ends.
- **`browser`** — `test/browser/`, run in Chromium, Firefox and WebKit through vitest browser mode with Playwright, against a local echo server started by its globalSetup. Opt-in: `pnpm test` leaves it out because it needs Playwright's browser binaries.

Releases go through `uppt` (`.github/workflows/release.yml`): a release PR on push to main, a tag and GitHub Release on merge, then a `pnpm pack` and an OIDC trusted publish to npm from the `npm` environment. There is no local release script — do not add one.

## Architecture

### Entry points and exports

One module per subpath, so a consumer downloads what it imports and nothing else. `test/exports.test.ts` pins each entry's runtime exports and the `package.json` exports map: anything not listed there is internal.

- `.` → `src/index.ts` — `S3Client`, `S3Error`, and every public type
- `./signer` → `src/signer.ts` — `signRequest`, `presignUrl`, `SigningKeyCache`, `sharedSigningKeyCache`
- `./endpoint` → `src/endpoint.ts` — `buildRequestUrl`, `encodeS3Key`
- `./mime` → `src/mime.ts` — `createContentTypeResolver`, `common`
- `./mime/*` → `src/mime/*.ts` — one extension-to-type table per group
- `./package.json`

Every module imports the module it needs directly, never a barrel: rolldown chunks by which entries reach a module, so a barrel import makes everything it re-exports look reached.

### Modules

- **`src/client.ts`** — `S3Client` class: high-level API (get, head, put, del, list, multipart, presigned URLs). Contains all retry logic, clock skew correction, checksum computation (SHA-256, CRC32C), and XML parsing for S3 responses. This is the largest file.
- **`src/error.ts`** — `S3Error` class with structured S3-specific error metadata (status, code, requestId, retriable, retryAfter, region).
- **`src/types.ts`** — All TypeScript interfaces and type definitions.
- **`src/signer.ts`** — AWS SigV4 request signing and presigned URLs using Web Crypto HMAC-SHA256, and the `SigningKeyCache` derived keys are kept in. `signRequest` returns the URL it signed, its query encoded the way it was signed.
- **`src/endpoint.ts`** — URL construction for virtual-hosted and path-style addressing, with DNS compatibility checks.
- **`src/mime.ts`** — `createContentTypeResolver(...tables)` and the `common` group. `S3Client` infers from `common` by default.
- **`src/mime/*.ts`** — frozen extension-to-type tables, one per group (`common`, `web`, `image`, `audio`, `video`, `font`, `document`, `data`, `archive`, `model`), each exported by name and as the default. `all` spreads every group over the long tail of IANA-registered types. Values are the IANA-registered type, or the de facto one where none exists or clients only recognize another.

### Internal modules (`src/internal/`, never exported)

- **`serializer.ts`** — Header building (conditional headers, range, cache-control), query parameter application, `finalizeQuery`, stream detection.
- **`encode.ts`** — RFC 3986 URI encoding.
- **`is.ts`** — Runtime-safe type guards for ArrayBuffer, Blob, ReadableStream, IP addresses, DNS-compatible bucket names, plain objects.

### Build

Uses `obuild` with rolldown in `neutral` platform mode. One bundle entry per subpath: `index.ts`, `signer.ts`, `endpoint.ts`, `mime.ts` and every file in `src/mime/`. Output goes to `dist/` as `.mjs` files, shared code in `dist/_chunks/`.

## Conventions

- Lint and format are oxc: `.oxlintrc.json` (type-aware, via `oxlint-tsgolint`) and `.oxfmtrc.json`. Those exact filenames are what the tools discover — an earlier `.oxclintrc.json` / `.oxcfmtrc.json` pair was silently never read.
- Source files use `.ts` extensions in imports (e.g., `import { S3Error } from "./error.ts"`).
- No runtime dependencies — all crypto uses `crypto.subtle`, all HTTP uses `fetch`.
- XML responses are parsed with simple regex extraction (`extractTag`), not a DOM parser. The patterns tolerate attributes on elements and unwrap `CDATA`, and entities are decoded in a SINGLE pass (`decodeXml`) — sequential replaces let `&amp;` cascade into the pass after it, which decodes escaped text twice.
- The query string that goes on the wire is written by `finalizeQuery`, with the same RFC 3986 encoder the signer canonicalizes with. `URLSearchParams` serialization (`+` for a space, `%7E` for a tilde) must never reach a request or a presigned URL: the signature covers the canonical bytes, and a store that recomputes them — AWS does — rejects anything else.
- Object keys reach the wire literally, which is why `encodeS3Key` throws on a `.` or `..` path segment. Every URL parser deletes those, so the alternative is silently writing to a different key. `%2e` is a dot to the parser too; there is no encoding that survives.
- Every public method takes `expectedStatus` and must honor it as `params.expectedStatus ?? <its own default>`. The caller's list _replaces_ the default; never merge, and never hard-code past it. `get`/`head` include `206` in their defaults because they serialize the `Range` header themselves.
- The project is in active development / pre-1.0. Expect breaking changes.
