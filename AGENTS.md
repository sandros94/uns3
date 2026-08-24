<!-- NOTE: Keep this file updated as the project evolves. When making architectural changes, adding new patterns, or discovering important conventions, update the relevant sections. -->

## Overview

uns3 is a tiny, zero-dependency, runtime-agnostic S3 client that works across Node.js, Deno, Bun, and browsers. It relies entirely on Web Crypto and Fetch APIs (no native dependencies). Compatible with AWS S3 and S3-compatible providers (Cloudflare R2, Hetzner, Backblaze B2, Garage, etc.).

## Commands

- **Install**: `pnpm install` (pnpm via Corepack, pinned by `packageManager`)
- **Build**: `pnpm build` (obuild)
- **Prepare**: `pnpm dev:prepare` (stub build + git hooks; what CI runs first)
- **Lint**: `pnpm lint` (`oxlint .` then `oxfmt --check .`)
- **Lint fix**: `pnpm fmt` (automd + `oxlint --fix` + `oxfmt`)
- **Type check**: `pnpm typecheck` (`tsgo --noEmit`)
- **Test all**: `pnpm test` (both vitest projects)
- **Unit only**: `pnpm test:unit` (fast; no container runtime needed)
- **Integration only**: `pnpm test:integration` (real stores in containers)
- **Run a single test**: `pnpm vitest run test/core/signer.test.ts`
- **Run tests in watch**: `pnpm vitest`
- **Benchmarks**: `pnpm bench`

## Tests

Two vitest projects, declared in `vitest.config.ts`:

- **`unit`** — everything under `test/` except `test/integration/`. Requests are
  answered by a `fetch` mock, so the suite needs nothing but a process. Keep it
  that way. `test/client.test.ts` also carries an env-gated block that talks to a
  real remote bucket; it stays skipped unless the `VITE_S3_*` variables are set.
- **`integration`** — `test/integration/`, the same battery run against real
  S3-compatible stores started as containers with testcontainers. Selected with
  `UNS3_TEST_STORES` (comma-separated), and skipped outright when there is no
  container runtime, so a machine without docker still gets a green `pnpm test`.

Releases go through `uppt` (`.github/workflows/release.yml`): a release PR on
push to main, a tag and GitHub Release on merge, then a `pnpm pack` and an OIDC
trusted publish to npm from the `npm` environment. There is no local release
script — do not add one.

## Architecture

### Entry points and exports

The package has three export paths defined in `package.json`:

- `.` → `src/index.ts` — re-exports `S3Client`, `S3Error`, all types, and `utils` namespace
- `./core` → `src/core.ts` — re-exports low-level internal core modules (signer, serializer, endpoint, transport, content-type, defaults)
- `./utils` → `src/utils.ts` — re-exports utility functions (MIME lookup, URI encoding, type guards)

### Key modules

- **`src/client.ts`** — `S3Client` class: high-level API (get, head, put, del, list, multipart, presigned URLs). Contains all retry logic, clock skew correction, checksum computation (SHA-256, CRC32C), and XML parsing for S3 responses. This is the largest file.
- **`src/error.ts`** — `S3Error` class with structured S3-specific error metadata (status, code, requestId, retriable, retryAfter, region).
- **`src/types.ts`** — All TypeScript interfaces and type definitions.

### Internal modules (`src/internal/`)

- **`core/signer.ts`** — AWS SigV4 request signing and presigned URL generation using Web Crypto HMAC-SHA256.
- **`core/endpoint.ts`** — URL construction supporting both virtual-hosted and path-style bucket addressing, with DNS compatibility checks.
- **`core/serializer.ts`** — Header building (conditional headers, range, cache-control), query parameter application, stream detection.
- **`core/content-type.ts`** — Content-type resolution from file extensions using the built-in MIME table.
- **`core/transport.ts`** — Thin fetch wrapper.
- **`core/defaults.ts`** — Constants (disallowed error headers).
- **`utils/mime.ts`** — Embedded MIME type lookup table (ported from mrmime).
- **`utils/encode.ts`** — RFC 3986 URI encoding.
- **`utils/is.ts`** — Runtime-safe type guards for ArrayBuffer, Blob, ReadableStream, DNS-compatible bucket names, plain objects.

### Build

Uses `obuild` with rolldown in `neutral` platform mode. Three bundle entry points: `index.ts`, `core.ts`, `utils.ts`. Output goes to `dist/` as `.mjs` files.

## Conventions

- Lint and format are oxc: `.oxlintrc.json` (type-aware, via `oxlint-tsgolint`) and
  `.oxfmtrc.json`. Those exact filenames are what the tools discover — an earlier
  `.oxclintrc.json` / `.oxcfmtrc.json` pair was silently never read.
- Source files use `.ts` extensions in imports (e.g., `import { S3Error } from "./error.ts"`).
- No runtime dependencies — all crypto uses `crypto.subtle`, all HTTP uses `fetch`.
- XML responses are parsed with simple regex extraction (`extractTag`), not a DOM
  parser. The patterns tolerate attributes on elements and unwrap `CDATA`, and
  entities are decoded in a SINGLE pass (`decodeXml`) — sequential replaces let
  `&amp;` cascade into the pass after it, which decodes escaped text twice.
- The query string that goes on the wire is written by `finalizeQuery`, with the
  same RFC 3986 encoder the signer canonicalizes with. `URLSearchParams`
  serialization (`+` for a space, `%7E` for a tilde) must never reach a request
  or a presigned URL: the signature covers the canonical bytes, and a store that
  recomputes them — AWS does — rejects anything else.
- Object keys reach the wire literally, which is why `encodeS3Key` throws on a
  `.` or `..` path segment. Every URL parser deletes those, so the alternative is
  silently writing to a different key. `%2e` is a dot to the parser too; there is
  no encoding that survives.
- Every public method takes `expectedStatus` and must honor it as
  `params.expectedStatus ?? <its own default>`. The caller's list _replaces_ the
  default; never merge, and never hard-code past it. `get`/`head` include `206`
  in their defaults because they serialize the `Range` header themselves.
- The project is in active development / pre-1.0. Expect breaking changes.
